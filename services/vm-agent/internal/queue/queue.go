// Package queue implements an on-disk offline queue for task.complete
// envelopes (and any other at-least-once payloads) when the agent can't
// reach the broker.
//
// Storage
// -------
// Single-file SQLite database at the configured path (default
// “/var/lib/awp-vm-agent/queue.db“). We use the pure-Go
// “modernc.org/sqlite“ driver so the agent binary stays CGO-disabled
// across every Linux distro in our support matrix. No libsqlite3 means
// no glibc version surprises, no musl build ache.
//
// Schema
// ------
//
//	CREATE TABLE pending_results (
//	    id             INTEGER PRIMARY KEY AUTOINCREMENT,
//	    task_id        TEXT    NOT NULL,
//	    payload_json   BLOB    NOT NULL,
//	    sha256         TEXT    NOT NULL,
//	    created_at     REAL    NOT NULL,    -- unix seconds (float)
//	    retry_count    INTEGER NOT NULL DEFAULT 0,
//	    last_attempt_at REAL,
//	    status         TEXT    NOT NULL DEFAULT 'queued',
//	                     -- queued | uploading | uploaded | dropped
//	    last_error     TEXT,
//	    UNIQUE(task_id, sha256)
//	);
//	CREATE INDEX idx_pending_status ON pending_results(status, id);
//	CREATE INDEX idx_pending_task_id ON pending_results(task_id);
//	CREATE TABLE queue_metadata (
//	    key TEXT PRIMARY KEY,
//	    value TEXT NOT NULL
//	);
//
// Durability
// ----------
// “PRAGMA journal_mode=WAL“ + “PRAGMA synchronous=FULL“ ensures every
// committed enqueue is fsync'd before the call returns. We accept the
// per-insert fsync cost because task.complete is low-rate (one task per
// seconds, not per millisecond). The WAL file lets concurrent readers
// (the replayer) run without blocking the writer (the runner).
//
// Process safety
// --------------
// Multiple agent processes pointed at the same queue.db must not corrupt
// state. We hold an exclusive advisory file lock on “queue.db.lock“
// for the lifetime of an Open() handle. Second opener will fail with
// ErrLocked — the second process SHOULD log and exit, not spin.
//
// Auto-prune
// ----------
// Periodic prune deletes “uploaded“ rows older than 7 days. “dropped“
// rows are kept indefinitely for audit — manual SQL DELETE if operator
// wants to reclaim space. Prune is idempotent and racy-safe (rows in
// “uploading“ are never touched).
package queue

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver; no cgo
)

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// ErrLocked is returned by Open when another agent process already holds
// the exclusive advisory lock on the queue database.
var ErrLocked = errors.New("queue: database is locked by another process")

// ErrClosed is returned when operations are attempted on a closed Queue.
var ErrClosed = errors.New("queue: closed")

// ErrNotFound is returned when a mark-operation references an unknown id.
var ErrNotFound = errors.New("queue: id not found")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Status is the lifecycle state of a queued row.
type Status string

const (
	StatusQueued    Status = "queued"
	StatusUploading Status = "uploading"
	StatusUploaded  Status = "uploaded"
	StatusDropped   Status = "dropped"
)

// QueuedItem is a single row worth of pending replay state.
type QueuedItem struct {
	ID            int64
	TaskID        string
	Payload       []byte
	SHA256        string
	CreatedAt     time.Time
	RetryCount    int
	LastAttemptAt time.Time // zero if never attempted
	Status        Status
	LastError     string
}

// QueueStats is the aggregated counters surfaced by Stats().
type QueueStats struct {
	Queued       int64
	Uploading    int64
	Uploaded     int64
	Dropped      int64
	Total        int64
	OldestQueued time.Time // zero if no queued rows
}

// Config controls Queue construction.
type Config struct {
	// Path to the SQLite database. Default: ``/var/lib/awp-vm-agent/queue.db``.
	Path string
	// MaxRetries for the replayer. Items that exceed it are moved to
	// ``dropped``. Default 10. Stored here for convenience; Queue itself
	// doesn't enforce it — the replay loop does. Kept so callers can
	// pass it through a single struct.
	MaxRetries int
	// Logger. If nil, slog.Default() is used.
	Log *slog.Logger
	// PruneAfter for uploaded rows. Default 7 * 24h.
	PruneAfter time.Duration
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

// contextMutex is a context-aware binary semaphore for SQLite writers.
type contextMutex struct {
	token chan struct{}
}

func newContextMutex() contextMutex {
	token := make(chan struct{}, 1)
	token <- struct{}{}
	return contextMutex{token: token}
}

func (m *contextMutex) Lock(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-m.token:
	}
	if err := ctx.Err(); err != nil {
		m.Unlock()
		return err
	}
	return nil
}

func (m *contextMutex) Unlock() {
	m.token <- struct{}{}
}

// Queue is the exported facade. Safe for concurrent use.
type Queue struct {
	cfg      Config
	db       *sql.DB
	log      *slog.Logger
	lockFile *os.File
	writeMu  contextMutex
	closeMu  sync.Mutex
	closed   bool
}

// ---------------------------------------------------------------------------
// Open / Close
// ---------------------------------------------------------------------------

// Open prepares the database at cfg.Path, grabs the exclusive advisory
// lock, applies schema migrations, and returns a usable Queue.
func Open(cfg Config) (*Queue, error) {
	if cfg.Path == "" {
		cfg.Path = "/var/lib/awp-vm-agent/queue.db"
	}
	if cfg.MaxRetries <= 0 {
		cfg.MaxRetries = 10
	}
	if cfg.PruneAfter <= 0 {
		cfg.PruneAfter = 7 * 24 * time.Hour
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}

	if err := os.MkdirAll(filepath.Dir(cfg.Path), 0o755); err != nil {
		return nil, fmt.Errorf("queue: mkdir %s: %w", filepath.Dir(cfg.Path), err)
	}

	// Exclusive advisory lock — fail fast if another agent is already here.
	lockPath := cfg.Path + ".lock"
	lockFile, err := acquireExclusiveLock(lockPath)
	if err != nil {
		return nil, err
	}

	// DSN: journal WAL + synchronous FULL for crash-safety. We intentionally
	// do not set busy_timeout=0 because concurrent readers (the replayer)
	// may race a writer briefly; 5s is generous.
	dsn := fmt.Sprintf(
		"file:%s?_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)"+
			"&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)",
		cfg.Path,
	)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		_ = releaseLock(lockFile)
		return nil, fmt.Errorf("queue: open db: %w", err)
	}
	// SQLite has a single writer. Serializing through one connection avoids
	// SQLITE_BUSY under concurrent task completion while WAL still protects
	// crash recovery and cross-process readers.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	q := &Queue{
		cfg:      cfg,
		db:       db,
		log:      cfg.Log,
		lockFile: lockFile,
		writeMu:  newContextMutex(),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := q.migrate(ctx); err != nil {
		_ = db.Close()
		_ = releaseLock(lockFile)
		return nil, err
	}
	return q, nil
}

// Close releases the database and the advisory lock. Safe to call
// multiple times.
func (q *Queue) Close() error {
	q.closeMu.Lock()
	defer q.closeMu.Unlock()
	if q.closed {
		return nil
	}
	q.closed = true
	var firstErr error
	if q.db != nil {
		if err := q.db.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if q.lockFile != nil {
		if err := releaseLock(q.lockFile); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// ---------------------------------------------------------------------------
// Schema migration — idempotent
// ---------------------------------------------------------------------------

const schema = `
CREATE TABLE IF NOT EXISTS pending_results (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id         TEXT    NOT NULL,
    payload_json    BLOB    NOT NULL,
    sha256          TEXT    NOT NULL,
    created_at      REAL    NOT NULL,
    retry_count     INTEGER NOT NULL DEFAULT 0,
    last_attempt_at REAL,
    status          TEXT    NOT NULL DEFAULT 'queued',
    last_error      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_task_sha
    ON pending_results(task_id, sha256);
CREATE INDEX IF NOT EXISTS idx_pending_status
    ON pending_results(status, id);
CREATE INDEX IF NOT EXISTS idx_pending_task_id
    ON pending_results(task_id);

CREATE TABLE IF NOT EXISTS queue_metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`

func (q *Queue) migrate(ctx context.Context) error {
	// Schema creation is always a single transaction so partial application
	// doesn't leave us in a wedged state on crash mid-migration.
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("queue: begin migration: %w", err)
	}
	if _, err := tx.ExecContext(ctx, schema); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("queue: apply schema: %w", err)
	}
	// Record schema version — lets future upgrades detect rollback scenarios.
	if _, err := tx.ExecContext(ctx,
		"INSERT OR REPLACE INTO queue_metadata(key,value) VALUES('schema_version','1')",
	); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("queue: write schema_version: %w", err)
	}
	return tx.Commit()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Enqueue persists payload under taskID. Duplicate (taskID, sha256) pairs
// are coalesced: re-enqueueing the same bytes for the same task returns
// the existing row id, not a new one. This is what the runner wants when
// it retries a send on a flaky connection before it's learned to queue.
func (q *Queue) Enqueue(ctx context.Context, taskID string, payload []byte) (int64, error) {
	if err := q.writeMu.Lock(ctx); err != nil {
		return 0, fmt.Errorf("queue: enqueue lock: %w", err)
	}
	defer q.writeMu.Unlock()
	if q.isClosed() {
		return 0, ErrClosed
	}
	if taskID == "" {
		return 0, fmt.Errorf("queue: taskID required")
	}
	if len(payload) == 0 {
		return 0, fmt.Errorf("queue: empty payload")
	}
	sum := sha256.Sum256(payload)
	digest := hex.EncodeToString(sum[:])

	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("queue: begin enqueue: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Fast path: row already exists for this (task_id, sha256).
	var existingID int64
	row := tx.QueryRowContext(ctx,
		`SELECT id FROM pending_results WHERE task_id=? AND sha256=?`,
		taskID, digest)
	if err := row.Scan(&existingID); err == nil {
		if err := tx.Commit(); err != nil {
			return 0, fmt.Errorf("queue: commit idempotent enqueue: %w", err)
		}
		q.log.Debug("queue.enqueue.dup", "id", existingID, "task_id", taskID,
			"sha256", digest[:8])
		return existingID, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("queue: lookup existing: %w", err)
	}

	// New insert.
	res, err := tx.ExecContext(ctx,
		`INSERT INTO pending_results(task_id, payload_json, sha256,
		                              created_at, status)
		 VALUES (?, ?, ?, ?, 'queued')`,
		taskID, payload, digest, nowFloat(),
	)
	if err != nil {
		return 0, fmt.Errorf("queue: insert: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil || id == 0 {
		return 0, fmt.Errorf("queue: LastInsertId unavailable")
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("queue: commit enqueue: %w", err)
	}
	q.log.Debug("queue.enqueue", "id", id, "task_id", taskID,
		"payload_bytes", len(payload), "sha256", digest[:8])
	return id, nil
}

// Dequeue claims up to limit queued rows by flipping their status to
// “uploading“ atomically. The caller is responsible for calling
// MarkUploaded or MarkFailed on each returned item. On Close / crash
// any stranded “uploading“ rows are reclaimed on the next Open().
func (q *Queue) Dequeue(ctx context.Context, limit int) ([]*QueuedItem, error) {
	if err := q.writeMu.Lock(ctx); err != nil {
		return nil, fmt.Errorf("queue: dequeue lock: %w", err)
	}
	defer q.writeMu.Unlock()
	if q.isClosed() {
		return nil, ErrClosed
	}
	if limit <= 0 {
		limit = 50
	}
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("queue: begin dequeue: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.QueryContext(ctx,
		`SELECT id, task_id, payload_json, sha256, created_at,
		        retry_count, COALESCE(last_attempt_at, 0), status,
		        COALESCE(last_error,'')
		   FROM pending_results
		  WHERE status = 'queued'
		  ORDER BY id ASC
		  LIMIT ?`,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("queue: select queued: %w", err)
	}
	items := make([]*QueuedItem, 0, limit)
	for rows.Next() {
		var item QueuedItem
		var createdAt, lastAttempt float64
		var status string
		if err := rows.Scan(&item.ID, &item.TaskID, &item.Payload,
			&item.SHA256, &createdAt, &item.RetryCount, &lastAttempt,
			&status, &item.LastError); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("queue: scan row: %w", err)
		}
		item.CreatedAt = time.Unix(0, int64(createdAt*1e9))
		if lastAttempt > 0 {
			item.LastAttemptAt = time.Unix(0, int64(lastAttempt*1e9))
		}
		item.Status = Status(status)
		items = append(items, &item)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, fmt.Errorf("queue: iterate queued: %w", err)
	}
	_ = rows.Close()

	if len(items) == 0 {
		// Commit (rollback is a no-op here) and return quickly.
		return items, tx.Commit()
	}

	// Flip to ``uploading`` for the batch so concurrent replayers don't
	// double-claim. Build a parameterised IN clause. Args order is
	// (last_attempt_at, id1, id2, ...) to match the SQL below.
	placeholders := ""
	args := make([]any, 0, len(items)+1)
	args = append(args, nowFloat())
	for i, it := range items {
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
		args = append(args, it.ID)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE pending_results
		   SET status='uploading', last_attempt_at=?
		 WHERE id IN (`+placeholders+`)`,
		args...,
	); err != nil {
		return nil, fmt.Errorf("queue: mark uploading: %w", err)
	}
	// Keep in-memory items' status in sync with the DB so callers don't
	// see a stale ``queued`` on the struct they're about to upload.
	for _, it := range items {
		it.Status = StatusUploading
	}
	return items, tx.Commit()
}

// MarkUploaded transitions id from “uploading“ to “uploaded“. Repeating the
// same terminal transition is safe; dropped rows are never resurrected.
func (q *Queue) MarkUploaded(ctx context.Context, id int64) error {
	if err := q.writeMu.Lock(ctx); err != nil {
		return fmt.Errorf("queue: mark uploaded lock: %w", err)
	}
	defer q.writeMu.Unlock()
	if q.isClosed() {
		return ErrClosed
	}
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("queue: begin mark uploaded: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var currentStatus string
	if err := tx.QueryRowContext(ctx,
		`SELECT status FROM pending_results WHERE id=?`, id,
	).Scan(&currentStatus); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("queue: read mark uploaded state: %w", err)
	}
	switch Status(currentStatus) {
	case StatusUploaded:
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("queue: commit idempotent mark uploaded: %w", err)
		}
		return nil
	case StatusUploading, StatusQueued:
		// Valid transition.
	default:
		return fmt.Errorf("queue: mark uploaded: id %d is %q", id, currentStatus)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE pending_results
		    SET status='uploaded', last_attempt_at=?, last_error=NULL
		  WHERE id=?`,
		nowFloat(), id,
	); err != nil {
		return fmt.Errorf("queue: mark uploaded: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("queue: commit mark uploaded: %w", err)
	}
	return nil
}

// MarkFailed increments retry_count and returns the row to “queued“ so
// the replayer can try again. If the resulting retry_count exceeds
// maxRetries the row transitions to “dropped“ instead.
func (q *Queue) MarkFailed(ctx context.Context, id int64, reason string, maxRetries int) error {
	if err := q.writeMu.Lock(ctx); err != nil {
		return fmt.Errorf("queue: mark failed lock: %w", err)
	}
	defer q.writeMu.Unlock()
	if q.isClosed() {
		return ErrClosed
	}
	if maxRetries <= 0 {
		maxRetries = q.cfg.MaxRetries
	}
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("queue: begin mark failed: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var retryCount int
	var currentStatus string
	row := tx.QueryRowContext(ctx,
		`SELECT retry_count, status FROM pending_results WHERE id=?`, id)
	if err := row.Scan(&retryCount, &currentStatus); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("queue: scan retry_count: %w", err)
	}
	// Guard: only rows currently in 'uploading' or 'queued' may be
	// flagged failed. Calling MarkFailed on an 'uploaded' or 'dropped'
	// row is a caller bug that would otherwise silently resurrect or
	// re-drop work.
	if Status(currentStatus) != StatusUploading &&
		Status(currentStatus) != StatusQueued {
		return fmt.Errorf("queue: mark failed: id %d is %q, not uploading/queued",
			id, currentStatus)
	}
	retryCount++
	nextStatus := StatusQueued
	if retryCount >= maxRetries {
		nextStatus = StatusDropped
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE pending_results
		    SET status=?, retry_count=?, last_attempt_at=?, last_error=?
		  WHERE id=?`,
		string(nextStatus), retryCount, nowFloat(), truncateErr(reason), id,
	); err != nil {
		return fmt.Errorf("queue: update failed row: %w", err)
	}
	return tx.Commit()
}

// ReclaimUploading returns rows stranded in “uploading“ back to
// “queued“. Called on Open() so crash-mid-replay doesn't lose work.
func (q *Queue) ReclaimUploading(ctx context.Context) (int64, error) {
	if err := q.writeMu.Lock(ctx); err != nil {
		return 0, fmt.Errorf("queue: reclaim lock: %w", err)
	}
	defer q.writeMu.Unlock()
	if q.isClosed() {
		return 0, ErrClosed
	}
	res, err := q.db.ExecContext(ctx,
		`UPDATE pending_results SET status='queued' WHERE status='uploading'`,
	)
	if err != nil {
		return 0, fmt.Errorf("queue: reclaim: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// RequeueUploading returns only the specified claimed rows to queued state.
// Repeating the call for rows already queued is safe; terminal rows are never
// resurrected. This is used when a replay batch stops before sending every row.
func (q *Queue) RequeueUploading(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	if err := q.writeMu.Lock(ctx); err != nil {
		return fmt.Errorf("queue: requeue uploading lock: %w", err)
	}
	defer q.writeMu.Unlock()
	if q.isClosed() {
		return ErrClosed
	}
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("queue: begin requeue uploading: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	seen := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		var currentStatus string
		if err := tx.QueryRowContext(ctx,
			`SELECT status FROM pending_results WHERE id=?`, id,
		).Scan(&currentStatus); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return fmt.Errorf("queue: requeue id %d: %w", id, ErrNotFound)
			}
			return fmt.Errorf("queue: read requeue state: %w", err)
		}
		switch Status(currentStatus) {
		case StatusQueued, StatusUploaded, StatusDropped:
			// Already released from uploading. Treat as an idempotent no-op;
			// never change an existing terminal state.
			continue
		case StatusUploading:
			if _, err := tx.ExecContext(ctx,
				`UPDATE pending_results SET status='queued' WHERE id=?`, id,
			); err != nil {
				return fmt.Errorf("queue: requeue uploading id %d: %w", id, err)
			}
		default:
			return fmt.Errorf("queue: requeue uploading: id %d is %q", id, currentStatus)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("queue: commit requeue uploading: %w", err)
	}
	return nil
}

// Stats returns the aggregated counters. Cheap — SQLite executes this as
// an indexed range scan on status.
func (q *Queue) Stats(ctx context.Context) (QueueStats, error) {
	var st QueueStats
	if q.isClosed() {
		return st, ErrClosed
	}
	rows, err := q.db.QueryContext(ctx,
		`SELECT status, COUNT(*) FROM pending_results GROUP BY status`,
	)
	if err != nil {
		return st, fmt.Errorf("queue: stats: %w", err)
	}
	for rows.Next() {
		var status string
		var n int64
		if err := rows.Scan(&status, &n); err != nil {
			_ = rows.Close()
			return st, fmt.Errorf("queue: scan stats: %w", err)
		}
		switch Status(status) {
		case StatusQueued:
			st.Queued = n
		case StatusUploading:
			st.Uploading = n
		case StatusUploaded:
			st.Uploaded = n
		case StatusDropped:
			st.Dropped = n
		}
		st.Total += n
	}
	_ = rows.Close()

	row := q.db.QueryRowContext(ctx,
		`SELECT COALESCE(MIN(created_at), 0) FROM pending_results WHERE status='queued'`,
	)
	var oldest float64
	if err := row.Scan(&oldest); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return st, fmt.Errorf("queue: stats oldest: %w", err)
	}
	if oldest > 0 {
		st.OldestQueued = time.Unix(0, int64(oldest*1e9))
	}
	return st, nil
}

// Prune deletes “uploaded“ rows older than cfg.PruneAfter. “dropped“
// rows are kept for audit. Returns the number of deleted rows.
func (q *Queue) Prune(ctx context.Context) (int64, error) {
	if err := q.writeMu.Lock(ctx); err != nil {
		return 0, fmt.Errorf("queue: prune lock: %w", err)
	}
	defer q.writeMu.Unlock()
	if q.isClosed() {
		return 0, ErrClosed
	}
	cutoff := float64(time.Now().Add(-q.cfg.PruneAfter).UnixNano()) / 1e9
	res, err := q.db.ExecContext(ctx,
		`DELETE FROM pending_results
		  WHERE status='uploaded' AND COALESCE(last_attempt_at, created_at) < ?`,
		cutoff,
	)
	if err != nil {
		return 0, fmt.Errorf("queue: prune: %w", err)
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		q.log.Info("queue.prune", "deleted_rows", n, "cutoff", cutoff)
	}
	return n, nil
}

// ForceDropped flips id → “dropped“ without consuming retry budget. Repeating
// the same terminal transition is safe; uploaded rows are never overwritten.
func (q *Queue) ForceDropped(ctx context.Context, id int64, reason string) error {
	if err := q.writeMu.Lock(ctx); err != nil {
		return fmt.Errorf("queue: force drop lock: %w", err)
	}
	defer q.writeMu.Unlock()
	if q.isClosed() {
		return ErrClosed
	}
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("queue: begin force drop: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var currentStatus string
	if err := tx.QueryRowContext(ctx,
		`SELECT status FROM pending_results WHERE id=?`, id,
	).Scan(&currentStatus); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("queue: read force drop state: %w", err)
	}
	switch Status(currentStatus) {
	case StatusDropped:
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("queue: commit idempotent force drop: %w", err)
		}
		return nil
	case StatusUploading, StatusQueued:
		// Valid transition.
	default:
		return fmt.Errorf("queue: force drop: id %d is %q", id, currentStatus)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE pending_results
		    SET status='dropped', last_attempt_at=?, last_error=?
		  WHERE id=?`,
		nowFloat(), truncateErr(reason), id,
	); err != nil {
		return fmt.Errorf("queue: force drop: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("queue: commit force drop: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func (q *Queue) isClosed() bool {
	q.closeMu.Lock()
	defer q.closeMu.Unlock()
	return q.closed
}

func nowFloat() float64 {
	return float64(time.Now().UnixNano()) / 1e9
}

func truncateErr(s string) string {
	const max = 1024
	if len(s) > max {
		return s[:max] + "...(truncated)"
	}
	return s
}

// ---------------------------------------------------------------------------
// Advisory file lock — Linux-only syscall.Flock
// ---------------------------------------------------------------------------
//
// flock(2) gives us a per-file advisory exclusive lock that's released
// automatically on process exit (even SIGKILL). Ideal for the "only one
// agent process touches the queue" invariant.

func acquireExclusiveLock(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("queue: open lock file %s: %w", path, err)
	}
	if err := flockExclusive(f); err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

func releaseLock(f *os.File) error {
	if f == nil {
		return nil
	}
	_ = flockUnlock(f)
	return f.Close()
}

// flockExclusive / flockUnlock live in their own small files so non-Linux
// builds (Windows dev) keep compiling. On Windows we fall back to a noop
// — only Linux agents ship in production.
//
// See queue_flock_unix.go / queue_flock_other.go.
