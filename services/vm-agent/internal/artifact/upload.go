// Package artifact implements the agent side of the signed-URL artifact
// transfer protocol (agent-protocol-v1 §7.1 + cloud Batch 2, 2026-04-19).
//
// The flow is:
//
//  1. RequestUploadURL() — POST /v1/agent/artifact/request-put with
//     {task_id, filename, content_type, size}. The cloud returns a signed
//     PUT URL minted by the local artifact backend, a
//     deadline, and an artifact id.
//  2. Upload() — streams the file body directly to the signed URL with
//     Content-Length set, hashing the bytes on the fly so we never double-
//     read the file. Retries 3× on 5xx with exponential backoff; 4xx errors
//     (signature reject, size exceeded) are terminal.
//  3. ReportComplete() — POST /v1/agent/artifact/report-complete with
//     {task_id, filename, sha256, size_bytes}. The cloud recomputes
//     sha256 on its side (local backend) and flips the row to `uploaded`,
//     triggering downstream artifact processing when configured.
//
// The package never logs the raw API key — it's copied into an
// Authorization header and dropped. All public functions accept a
// context.Context for deadline / cancellation propagation.
package artifact

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

// SignedURL captures the presign response from the cloud. Kept minimal so
// new fields on the server side don't break unmarshal.
type SignedURL struct {
	UploadURL        string `json:"upload_url"`
	Method           string `json:"method"`
	ExpiresAt        int64  `json:"expires_at"`
	MaxSize          int64  `json:"max_size"`
	ChecksumRequired bool   `json:"checksum_required"`
	ArtifactID       int64  `json:"artifact_id"`
}

type reportCompleteRequest struct {
	TaskID    string `json:"task_id"`
	Filename  string `json:"filename"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"size_bytes"`
}

type reportCompleteResponse struct {
	OK         bool   `json:"ok"`
	ArtifactID int64  `json:"artifact_id"`
	Status     string `json:"status"`
	Parsed     bool   `json:"parsed"`
}

type requestPutRequest struct {
	TaskID      string `json:"task_id"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
}

// ---------------------------------------------------------------------------
// Client — stateless; reuses a single *http.Client for HTTP/2 + keepalive.
// ---------------------------------------------------------------------------

// Client talks to the Agent Workflow Platform artifact endpoints. The zero value is not
// usable — construct via New.
type Client struct {
	// BaseURL is the cloud root, e.g. http://127.0.0.1:8100 . Trailing
	// slashes are stripped on construction.
	BaseURL string
	// AgentToken is the opaque bearer (never logged, never marshaled).
	AgentToken string
	// HTTP carries the outbound requests. New installs its own with a
	// 300s per-request timeout; callers may override for tests.
	HTTP *http.Client
}

// defaultHTTPTimeout applies to non-upload requests (request-put and
// report-complete). Uploads get a per-call deadline via ctx instead so
// a multi-gigabyte artifact doesn't wedge on a fixed cap.
const defaultHTTPTimeout = 30 * time.Second

// New builds a Client with sensible defaults. baseURL must be non-empty.
func New(baseURL, token string) (*Client, error) {
	if baseURL == "" {
		return nil, errors.New("artifact.New: baseURL is empty")
	}
	if token == "" {
		return nil, errors.New("artifact.New: token is empty")
	}
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		AgentToken: token,
		HTTP: &http.Client{
			Timeout: defaultHTTPTimeout,
		},
	}, nil
}

// ---------------------------------------------------------------------------
// RequestUploadURL
// ---------------------------------------------------------------------------

// RequestUploadURL asks the cloud to mint a signed PUT URL for the
// given task + filename. The cloud verifies the task belongs to the
// authenticated agent's tenant; a 403 here typically means the
// agent's API key was issued for a different tenant than the task.
func (c *Client) RequestUploadURL(
	ctx context.Context,
	taskID, filename, contentType string,
	sizeBytes int64,
) (*SignedURL, error) {
	if taskID == "" || filename == "" {
		return nil, errors.New("RequestUploadURL: task_id and filename are required")
	}
	if sizeBytes <= 0 {
		return nil, errors.New("RequestUploadURL: size_bytes must be > 0")
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	body, err := json.Marshal(&requestPutRequest{
		TaskID:      taskID,
		Filename:    filename,
		ContentType: contentType,
		SizeBytes:   sizeBytes,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal request-put: %w", err)
	}

	endpoint := c.BaseURL + "/v1/agent/artifact/request-put"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request-put: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.AgentToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request-put do: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Read up to 4 KiB of body for diagnostics; don't log secrets.
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf(
			"request-put rejected: status=%d body=%q",
			resp.StatusCode, snippet,
		)
	}

	var signed SignedURL
	if err := json.NewDecoder(resp.Body).Decode(&signed); err != nil {
		return nil, fmt.Errorf("decode request-put response: %w", err)
	}
	if signed.UploadURL == "" {
		return nil, errors.New("request-put: empty upload_url in response")
	}
	if signed.Method == "" {
		signed.Method = http.MethodPut
	}
	return &signed, nil
}

// ---------------------------------------------------------------------------
// Upload — streams a file to the signed URL, hashing on the fly
// ---------------------------------------------------------------------------

// hashedReader is an io.Reader that computes a running sha256 over what it
// yields. After the stream is drained, Sum() returns the hex digest.
type hashedReader struct {
	r    io.Reader
	hash io.Writer // actually *sha256.digest, kept behind io.Writer to let tests swap
}

func (h *hashedReader) Read(p []byte) (int, error) {
	n, err := h.r.Read(p)
	if n > 0 {
		// sha256's Write never errors; we intentionally ignore the returned error.
		_, _ = h.hash.Write(p[:n])
	}
	return n, err
}

// UploadBackoff is the retry policy used by Upload. Exposed for tests.
type UploadBackoff struct {
	Attempts   int
	BaseDelay  time.Duration
	MaxDelay   time.Duration
	Multiplier float64
}

// DefaultBackoff returns a 3-attempt exponential backoff starting at 500ms.
func DefaultBackoff() UploadBackoff {
	return UploadBackoff{
		Attempts:   3,
		BaseDelay:  500 * time.Millisecond,
		MaxDelay:   5 * time.Second,
		Multiplier: 2.0,
	}
}

// Upload streams the file at path to the signed URL. Returns the sha256
// hex digest computed over the transmitted bytes so the caller can
// forward it to ReportComplete without re-reading the file.
//
// Retries on 5xx; 4xx is terminal (signature reject, size exceeded). The
// retry loop re-opens the file each attempt so the reader position is
// fresh — PUT handlers that partially consumed the stream before failing
// would otherwise see truncated subsequent attempts.
func (c *Client) Upload(
	ctx context.Context,
	path string,
	signed *SignedURL,
) (string, error) {
	return c.UploadWithBackoff(ctx, path, signed, DefaultBackoff())
}

// UploadWithBackoff is Upload with a caller-supplied retry policy.
func (c *Client) UploadWithBackoff(
	ctx context.Context,
	path string,
	signed *SignedURL,
	bk UploadBackoff,
) (string, error) {
	if signed == nil || signed.UploadURL == "" {
		return "", errors.New("Upload: signed URL is empty")
	}
	if bk.Attempts <= 0 {
		bk.Attempts = 1
	}

	stat, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("Upload: stat %s: %w", path, err)
	}
	if signed.MaxSize > 0 && stat.Size() > signed.MaxSize {
		return "", fmt.Errorf(
			"Upload: file size %d exceeds signed max %d",
			stat.Size(), signed.MaxSize,
		)
	}

	// Validate URL shape — we don't want Go's client to accidentally follow
	// a redirect to an unrelated host if the server ever hands us back a
	// garbled URL. Parse early to fail fast.
	if _, err := url.Parse(signed.UploadURL); err != nil {
		return "", fmt.Errorf("Upload: invalid signed URL: %w", err)
	}

	contentType := "application/octet-stream"
	if ct := contentTypeHint(signed); ct != "" {
		contentType = ct
	}

	method := signed.Method
	if method == "" {
		method = http.MethodPut
	}

	var lastErr error
	delay := bk.BaseDelay
	var finalDigest string
	for attempt := 1; attempt <= bk.Attempts; attempt++ {
		// Honour cancellation between retries.
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		default:
		}

		digest, err := c.uploadOnce(ctx, path, stat.Size(), method, signed.UploadURL, contentType)
		if err == nil {
			finalDigest = digest
			return finalDigest, nil
		}

		// Classify: retry on 5xx or network error; stop on 4xx.
		var httpErr *httpStatusError
		if errors.As(err, &httpErr) && httpErr.Status >= 400 && httpErr.Status < 500 {
			return "", fmt.Errorf("upload terminal (status=%d): %w", httpErr.Status, err)
		}

		lastErr = err
		if attempt == bk.Attempts {
			break
		}

		// Sleep with context cancellation awareness.
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return "", ctx.Err()
		case <-timer.C:
		}
		next := time.Duration(float64(delay) * bk.Multiplier)
		if next > bk.MaxDelay && bk.MaxDelay > 0 {
			next = bk.MaxDelay
		}
		delay = next
	}

	return "", fmt.Errorf("upload: exhausted %d attempts, last=%w", bk.Attempts, lastErr)
}

// contentTypeHint pulls a Content-Type from the signed URL's query string
// if the cloud minted one (the HMAC envelope carries it in the `ct`
// parameter). Falls back to empty, leaving the caller to decide.
func contentTypeHint(s *SignedURL) string {
	u, err := url.Parse(s.UploadURL)
	if err != nil {
		return ""
	}
	return u.Query().Get("ct")
}

// httpStatusError wraps a non-2xx response with its status so the retry
// loop can classify it without re-parsing the underlying error string.
type httpStatusError struct {
	Status int
	Body   string
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("http status %d: %s", e.Status, e.Body)
}

func (c *Client) uploadOnce(
	ctx context.Context,
	path string,
	size int64,
	method, signedURL, contentType string,
) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	h := sha256.New()
	reader := &hashedReader{r: f, hash: h}

	req, err := http.NewRequestWithContext(ctx, method, signedURL, reader)
	if err != nil {
		return "", fmt.Errorf("build upload: %w", err)
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", contentType)
	// Some presigners (OSS) sign Content-Length explicitly; the Go
	// client auto-populates it from req.ContentLength but we set it
	// as a hint for any middle boxes.
	req.Header.Set("Content-Length", strconv.FormatInt(size, 10))

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("upload do: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode/100 != 2 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return "", &httpStatusError{Status: resp.StatusCode, Body: string(snippet)}
	}
	// Drain the body so the connection is returned to the pool.
	_, _ = io.Copy(io.Discard, resp.Body)

	return hex.EncodeToString(h.Sum(nil)), nil
}

// ---------------------------------------------------------------------------
// ReportComplete
// ---------------------------------------------------------------------------

// ReportComplete informs the cloud that bytes have landed. The sha256
// MUST match the value returned by Upload — the cloud re-verifies on
// local-backend deployments.
func (c *Client) ReportComplete(
	ctx context.Context,
	taskID, filename, sha256hex string,
	sizeBytes int64,
) (*ReportCompleteResult, error) {
	if taskID == "" || filename == "" {
		return nil, errors.New("ReportComplete: task_id and filename required")
	}
	if len(sha256hex) != 64 {
		return nil, errors.New("ReportComplete: sha256 must be 64 hex chars")
	}

	body, err := json.Marshal(&reportCompleteRequest{
		TaskID:    taskID,
		Filename:  filename,
		SHA256:    sha256hex,
		SizeBytes: sizeBytes,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal report-complete: %w", err)
	}

	endpoint := c.BaseURL + "/v1/agent/artifact/report-complete"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build report-complete: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.AgentToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("report-complete do: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf(
			"report-complete rejected: status=%d body=%q",
			resp.StatusCode, snippet,
		)
	}

	var decoded reportCompleteResponse
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return nil, fmt.Errorf("decode report-complete: %w", err)
	}
	return &ReportCompleteResult{
		OK:         decoded.OK,
		ArtifactID: decoded.ArtifactID,
		Status:     decoded.Status,
		Parsed:     decoded.Parsed,
	}, nil
}

// ReportCompleteResult is what the cloud returns after acking an upload.
// Public type so callers can inspect “Parsed“ to know whether downstream
// downstream processing was triggered.
type ReportCompleteResult struct {
	OK         bool
	ArtifactID int64
	Status     string
	Parsed     bool
}
