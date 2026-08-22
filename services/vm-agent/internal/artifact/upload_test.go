// Hermetic unit tests for the artifact client. Uses net/http/httptest to
// stand in for both the cloud control plane (/v1/agent/artifact/*) and the
// signed-URL destination (typically OSS / the HMAC upload route). No real
// network activity; no real filesystem outside t.TempDir().
package artifact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// fakeCloud mounts /v1/agent/artifact/{request-put,report-complete}. The
// put URL it hands back points at the caller-supplied storage handler so
// tests can inject failures on the upload side.
type fakeCloud struct {
	t           *testing.T
	storageSrv  *httptest.Server
	reqPutCalls atomic.Int32
	reqPut      func(w http.ResponseWriter, r *http.Request) // override
	reportCalls atomic.Int32
	report      func(w http.ResponseWriter, r *http.Request) // override
}

func newFakeCloud(t *testing.T, storageSrv *httptest.Server) *fakeCloud {
	return &fakeCloud{t: t, storageSrv: storageSrv}
}

func (f *fakeCloud) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/agent/artifact/request-put", func(w http.ResponseWriter, r *http.Request) {
		f.reqPutCalls.Add(1)
		if f.reqPut != nil {
			f.reqPut(w, r)
			return
		}
		if h := r.Header.Get("Authorization"); !strings.HasPrefix(h, "Bearer ") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body requestPutRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// Default: hand back a URL pointing at the fake storage server.
		resp := SignedURL{
			UploadURL:        f.storageSrv.URL + "/put?ct=" + body.ContentType,
			Method:           "PUT",
			ExpiresAt:        time.Now().Add(5 * time.Minute).Unix(),
			MaxSize:          body.SizeBytes,
			ChecksumRequired: true,
			ArtifactID:       42,
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
	mux.HandleFunc("/v1/agent/artifact/report-complete", func(w http.ResponseWriter, r *http.Request) {
		f.reportCalls.Add(1)
		if f.report != nil {
			f.report(w, r)
			return
		}
		var body reportCompleteRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if len(body.SHA256) != 64 {
			http.Error(w, "bad sha256", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(reportCompleteResponse{
			OK: true, ArtifactID: 42, Status: "uploaded", Parsed: true,
		})
	})
	return mux
}

// storageReplay exposes what the storage server received on PUT.
type storageReplay struct {
	calls      atomic.Int32
	lastBody   []byte
	failTimes  int
	failStatus int
}

func newStorage(t *testing.T, r *storageReplay) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		n := r.calls.Add(1)
		if req.Method != "PUT" {
			http.Error(w, "method", http.StatusBadRequest)
			return
		}
		if r.failStatus != 0 && int(n) <= r.failTimes {
			// Consume the body so the client sees a real response, not a
			// broken write.
			_, _ = io.Copy(io.Discard, req.Body)
			w.WriteHeader(r.failStatus)
			return
		}
		body, _ := io.ReadAll(req.Body)
		r.lastBody = body
		w.WriteHeader(http.StatusOK)
	}))
}

func writeTempFile(t *testing.T, name string, payload []byte) string {
	t.Helper()
	dir := t.TempDir()
	full := filepath.Join(dir, name)
	if err := os.WriteFile(full, payload, 0o600); err != nil {
		t.Fatalf("write temp: %v", err)
	}
	return full
}

// ---------------------------------------------------------------------------
// RequestUploadURL
// ---------------------------------------------------------------------------

func TestNewRejectsEmptyBaseURL(t *testing.T) {
	_, err := New("", "token")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestNewRejectsEmptyToken(t *testing.T) {
	_, err := New("https://x", "")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestRequestUploadURLHappyPath(t *testing.T) {
	storage := newStorage(t, &storageReplay{})
	defer storage.Close()
	cloud := newFakeCloud(t, storage)
	srv := httptest.NewServer(cloud.handler())
	defer srv.Close()

	c, err := New(srv.URL, "tok")
	if err != nil {
		t.Fatal(err)
	}

	signed, err := c.RequestUploadURL(context.Background(), "task-1", "out.bin", "application/octet-stream", 128)
	if err != nil {
		t.Fatalf("RequestUploadURL: %v", err)
	}
	if signed.UploadURL == "" {
		t.Fatal("empty upload_url")
	}
	if signed.ArtifactID != 42 {
		t.Fatalf("unexpected artifact_id: %d", signed.ArtifactID)
	}
}

func TestRequestUploadURLBadInput(t *testing.T) {
	c, _ := New("http://unused", "tok")
	cases := []struct {
		name     string
		task     string
		filename string
		size     int64
	}{
		{"empty_task", "", "f.bin", 128},
		{"empty_filename", "t1", "", 128},
		{"zero_size", "t1", "f.bin", 0},
		{"negative_size", "t1", "f.bin", -5},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			_, err := c.RequestUploadURL(context.Background(), tc.task, tc.filename, "", tc.size)
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestRequestUploadURLForwardsAuthAndRejects401(t *testing.T) {
	cloud := newFakeCloud(t, httptest.NewServer(http.NotFoundHandler()))
	defer cloud.storageSrv.Close()
	cloud.reqPut = func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer my-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(SignedURL{UploadURL: cloud.storageSrv.URL + "/put"})
	}
	srv := httptest.NewServer(cloud.handler())
	defer srv.Close()

	// Wrong token → 401
	c, _ := New(srv.URL, "wrong-token")
	_, err := c.RequestUploadURL(context.Background(), "t", "f.bin", "", 128)
	if err == nil {
		t.Fatal("expected 401 error")
	}
	if !strings.Contains(err.Error(), "status=401") {
		t.Fatalf("err=%v does not mention 401", err)
	}

	// Right token → OK
	c2, _ := New(srv.URL, "my-token")
	if _, err := c2.RequestUploadURL(context.Background(), "t", "f.bin", "", 128); err != nil {
		t.Fatalf("unexpected: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

func TestUploadHappyPathComputesSHA256(t *testing.T) {
	payload := []byte("hello artifact payload")
	want := sha256.Sum256(payload)
	wantHex := hex.EncodeToString(want[:])

	replay := &storageReplay{}
	storage := newStorage(t, replay)
	defer storage.Close()
	cloud := newFakeCloud(t, storage)
	srv := httptest.NewServer(cloud.handler())
	defer srv.Close()

	path := writeTempFile(t, "out.bin", payload)
	c, _ := New(srv.URL, "tok")
	signed, err := c.RequestUploadURL(context.Background(), "task-1", "out.bin", "application/octet-stream", int64(len(payload)))
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.Upload(context.Background(), path, signed)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if got != wantHex {
		t.Fatalf("sha256 mismatch: got=%s want=%s", got, wantHex)
	}
	if string(replay.lastBody) != string(payload) {
		t.Fatalf("server received %q want %q", replay.lastBody, payload)
	}
	if replay.calls.Load() != 1 {
		t.Fatalf("unexpected call count: %d", replay.calls.Load())
	}
}

func TestUploadRetriesOn5xx(t *testing.T) {
	replay := &storageReplay{failTimes: 2, failStatus: 503}
	storage := newStorage(t, replay)
	defer storage.Close()
	cloud := newFakeCloud(t, storage)
	srv := httptest.NewServer(cloud.handler())
	defer srv.Close()

	path := writeTempFile(t, "x.bin", []byte("retry me"))
	c, _ := New(srv.URL, "tok")
	signed, _ := c.RequestUploadURL(context.Background(), "t", "x.bin", "", 8)

	bk := UploadBackoff{Attempts: 4, BaseDelay: time.Millisecond, MaxDelay: time.Millisecond, Multiplier: 1}
	if _, err := c.UploadWithBackoff(context.Background(), path, signed, bk); err != nil {
		t.Fatalf("Upload should have succeeded after 5xx retries: %v", err)
	}
	if replay.calls.Load() != 3 {
		t.Fatalf("expected 3 server hits (2 fail + 1 ok); got %d", replay.calls.Load())
	}
}

func TestUploadDoesNotRetry4xx(t *testing.T) {
	replay := &storageReplay{failTimes: 99, failStatus: 413}
	storage := newStorage(t, replay)
	defer storage.Close()
	cloud := newFakeCloud(t, storage)
	srv := httptest.NewServer(cloud.handler())
	defer srv.Close()

	path := writeTempFile(t, "big.bin", []byte("oversize"))
	c, _ := New(srv.URL, "tok")
	signed, _ := c.RequestUploadURL(context.Background(), "t", "big.bin", "", 8)

	bk := UploadBackoff{Attempts: 5, BaseDelay: time.Millisecond, Multiplier: 1}
	_, err := c.UploadWithBackoff(context.Background(), path, signed, bk)
	if err == nil {
		t.Fatal("expected 4xx terminal failure")
	}
	if replay.calls.Load() != 1 {
		t.Fatalf("4xx should not retry; got %d hits", replay.calls.Load())
	}
}

func TestUploadRespectsSignedMaxSize(t *testing.T) {
	storage := newStorage(t, &storageReplay{})
	defer storage.Close()
	cloud := newFakeCloud(t, storage)
	srv := httptest.NewServer(cloud.handler())
	defer srv.Close()

	path := writeTempFile(t, "oversize.bin", []byte("twelve bytes"))
	c, _ := New(srv.URL, "tok")
	// Deliberately tell the cloud size=5, receive a max_size=5 signed URL.
	signed := &SignedURL{
		UploadURL: storage.URL + "/put",
		Method:    "PUT",
		MaxSize:   5,
	}
	_, err := c.Upload(context.Background(), path, signed)
	if err == nil {
		t.Fatal("expected local size-check failure")
	}
}

func TestUploadContextCancellationBetweenRetries(t *testing.T) {
	replay := &storageReplay{failTimes: 99, failStatus: 503}
	storage := newStorage(t, replay)
	defer storage.Close()
	cloud := newFakeCloud(t, storage)
	srv := httptest.NewServer(cloud.handler())
	defer srv.Close()

	path := writeTempFile(t, "x.bin", []byte("data"))
	c, _ := New(srv.URL, "tok")
	signed, _ := c.RequestUploadURL(context.Background(), "t", "x.bin", "", 4)

	ctx, cancel := context.WithCancel(context.Background())
	// Cancel after a single 5xx response.
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	bk := UploadBackoff{Attempts: 10, BaseDelay: 200 * time.Millisecond, Multiplier: 1}
	_, err := c.UploadWithBackoff(ctx, path, signed, bk)
	if err == nil {
		t.Fatal("expected cancellation error")
	}
	if !errors.Is(err, context.Canceled) {
		// Also accept via errors.Is on the wrapped chain.
		if !strings.Contains(err.Error(), "context canceled") {
			t.Fatalf("unexpected err: %v", err)
		}
	}
}

// ---------------------------------------------------------------------------
// ReportComplete
// ---------------------------------------------------------------------------

func TestReportCompleteSendsExpectedPayload(t *testing.T) {
	sum := sha256.Sum256([]byte("hi"))
	wantHex := hex.EncodeToString(sum[:])

	var captured reportCompleteRequest
	cloud := newFakeCloud(t, httptest.NewServer(http.NotFoundHandler()))
	defer cloud.storageSrv.Close()
	cloud.report = func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		_ = json.NewEncoder(w).Encode(reportCompleteResponse{OK: true, ArtifactID: 99, Status: "uploaded", Parsed: true})
	}
	srv := httptest.NewServer(cloud.handler())
	defer srv.Close()

	c, _ := New(srv.URL, "tok")
	res, err := c.ReportComplete(context.Background(), "t1", "out.bin", wantHex, 123)
	if err != nil {
		t.Fatalf("ReportComplete: %v", err)
	}
	if captured.TaskID != "t1" || captured.Filename != "out.bin" {
		t.Fatalf("payload mismatch: %+v", captured)
	}
	if captured.SHA256 != wantHex {
		t.Fatalf("sha256 mismatch in report: %s", captured.SHA256)
	}
	if res.ArtifactID != 99 || !res.OK || !res.Parsed {
		t.Fatalf("result mismatch: %+v", res)
	}
}

func TestReportCompleteRejectsShortSHA(t *testing.T) {
	c, _ := New("http://x", "tok")
	_, err := c.ReportComplete(context.Background(), "t1", "f.bin", "too-short", 1)
	if err == nil {
		t.Fatal("expected validation error")
	}
}

func TestReportCompletePropagatesNon200(t *testing.T) {
	cloud := newFakeCloud(t, httptest.NewServer(http.NotFoundHandler()))
	defer cloud.storageSrv.Close()
	cloud.report = func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "sha256 mismatch", http.StatusConflict)
	}
	srv := httptest.NewServer(cloud.handler())
	defer srv.Close()

	c, _ := New(srv.URL, "tok")
	sum := sha256.Sum256([]byte("x"))
	_, err := c.ReportComplete(context.Background(), "t", "f.bin", hex.EncodeToString(sum[:]), 1)
	if err == nil {
		t.Fatal("expected 409")
	}
	if !strings.Contains(err.Error(), "status=409") {
		t.Fatalf("expected 409 in error: %v", err)
	}
}

// ---------------------------------------------------------------------------
// End-to-end round-trip — exercises all three steps together.
// ---------------------------------------------------------------------------

func TestEndToEndRoundTrip(t *testing.T) {
	payload := []byte("end to end artifact payload")
	wantSum := sha256.Sum256(payload)
	wantHex := hex.EncodeToString(wantSum[:])

	storage := newStorage(t, &storageReplay{})
	defer storage.Close()
	cloud := newFakeCloud(t, storage)
	srv := httptest.NewServer(cloud.handler())
	defer srv.Close()

	path := writeTempFile(t, "e2e.bin", payload)
	c, _ := New(srv.URL, "tok")

	signed, err := c.RequestUploadURL(context.Background(), "task-e2e", "e2e.bin", "application/octet-stream", int64(len(payload)))
	if err != nil {
		t.Fatalf("request-put: %v", err)
	}
	digest, err := c.Upload(context.Background(), path, signed)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if digest != wantHex {
		t.Fatalf("digest mismatch: %s vs %s", digest, wantHex)
	}
	res, err := c.ReportComplete(context.Background(), "task-e2e", "e2e.bin", digest, int64(len(payload)))
	if err != nil {
		t.Fatalf("report-complete: %v", err)
	}
	if !res.OK {
		t.Fatalf("result not ok: %+v", res)
	}
	// Exactly 1 request-put + 1 upload + 1 report-complete.
	if got := cloud.reqPutCalls.Load(); got != 1 {
		t.Fatalf("reqPut calls: %d", got)
	}
	if got := cloud.reportCalls.Load(); got != 1 {
		t.Fatalf("report calls: %d", got)
	}
}

// ---------------------------------------------------------------------------
// hashedReader
// ---------------------------------------------------------------------------

func TestHashedReaderTracksAllBytes(t *testing.T) {
	data := []byte("abcdefghij")
	h := sha256.New()
	rdr := &hashedReader{r: strings.NewReader(string(data)), hash: h}
	out, err := io.ReadAll(rdr)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != string(data) {
		t.Fatalf("data mismatch")
	}
	want := sha256.Sum256(data)
	if fmt.Sprintf("%x", h.Sum(nil)) != fmt.Sprintf("%x", want[:]) {
		t.Fatalf("hash mismatch")
	}
}
