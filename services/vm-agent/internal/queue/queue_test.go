package queue

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

func testQueue(t *testing.T) (*Queue, string, func()) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "queue.db")
	q, err := Open(Config{Path: path, MaxRetries: 3, PruneAfter: time.Hour})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	cleanup := func() {
		_ = q.Close()
	}
	return q, path, cleanup
}

// ---------------------------------------------------------------------------
// Case 1 — Enqueue → Stats → Dequeue → MarkUploaded happy path.
// ---------------------------------------------------------------------------

func TestEnqueueDequeueMarkUploaded(t *testing.T) {
	q, _, cleanup := testQueue(t)
	defer cleanup()
	ctx := context.Background()

	id, err := q.Enqueue(ctx, "task-1", []byte(`{"status":"success"}`))
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	if id <= 0 {
		t.Fatalf("Enqueue returned non-positive id %d", id)
	}

	st, err := q.Stats(ctx)
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if st.Queued != 1 || st.Total != 1 {
		t.Fatalf("expected 1 queued, got %+v", st)
	}
	if st.OldestQueued.IsZero() {
		t.Fatal("OldestQueued should not be zero when queue has rows")
	}

	items, err := q.Dequeue(ctx, 10)
	if err != nil {
		t.Fatalf("Dequeue: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(items))
	}
	if items[0].Status != StatusUploading {
		t.Fatalf("dequeued item should be in 'uploading', got %q",
			items[0].Status)
	}
	if string(items[0].Payload) != `{"status":"success"}` {
		t.Fatalf("payload mismatch: %q", items[0].Payload)
	}

	if err := q.MarkUploaded(ctx, id); err != nil {
		t.Fatalf("MarkUploaded: %v", err)
	}
	st, _ = q.Stats(ctx)
	if st.Uploaded != 1 || st.Queued != 0 {
		t.Fatalf("expected 1 uploaded 0 queued, got %+v", st)
	}
}

// ---------------------------------------------------------------------------
// Case 2 — MarkFailed retries until dropped.
// ---------------------------------------------------------------------------

func TestMarkFailedRetriesUntilDropped(t *testing.T) {
	q, _, cleanup := testQueue(t)
	defer cleanup()
	ctx := context.Background()

	id, err := q.Enqueue(ctx, "task-2", []byte("payload"))
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	items, err := q.Dequeue(ctx, 10)
	if err != nil || len(items) != 1 {
		t.Fatalf("Dequeue: %v len=%d", err, len(items))
	}
	if items[0].ID != id {
		t.Fatalf("id mismatch %d vs %d", items[0].ID, id)
	}

	// MaxRetries=3 → fail 3× ⇒ dropped
	if err := q.MarkFailed(ctx, id, "network timeout", 3); err != nil {
		t.Fatalf("MarkFailed 1: %v", err)
	}
	items, _ = q.Dequeue(ctx, 10)
	if len(items) != 1 {
		t.Fatalf("expected item to be re-queued after fail 1, got %d", len(items))
	}
	if items[0].RetryCount != 1 {
		t.Fatalf("retry_count should be 1, got %d", items[0].RetryCount)
	}

	_ = q.MarkFailed(ctx, id, "network timeout", 3)
	items, _ = q.Dequeue(ctx, 10)
	if len(items) != 1 {
		t.Fatalf("expected re-queued after fail 2, got %d", len(items))
	}

	_ = q.MarkFailed(ctx, id, "exhausted", 3)
	// retry_count now 3 which is >= maxRetries → dropped
	items, _ = q.Dequeue(ctx, 10)
	if len(items) != 0 {
		t.Fatalf("expected 0 queued after 3 failures, got %d", len(items))
	}
	st, _ := q.Stats(ctx)
	if st.Dropped != 1 {
		t.Fatalf("expected 1 dropped row, got %+v", st)
	}
}

// ---------------------------------------------------------------------------
// Case 3 — Enqueue is idempotent on (task_id, sha256).
// ---------------------------------------------------------------------------

func TestEnqueueIdempotent(t *testing.T) {
	q, _, cleanup := testQueue(t)
	defer cleanup()
	ctx := context.Background()

	payload := []byte("same-bytes")
	id1, err := q.Enqueue(ctx, "task-3", payload)
	if err != nil {
		t.Fatal(err)
	}
	id2, err := q.Enqueue(ctx, "task-3", payload)
	if err != nil {
		t.Fatal(err)
	}
	if id1 != id2 {
		t.Fatalf("idempotent Enqueue should return same id, got %d vs %d",
			id1, id2)
	}
	st, _ := q.Stats(ctx)
	if st.Total != 1 {
		t.Fatalf("expected 1 row after dedupe, got %+v", st)
	}

	// Different payload for same task → new row.
	id3, err := q.Enqueue(ctx, "task-3", []byte("other-bytes"))
	if err != nil {
		t.Fatal(err)
	}
	if id3 == id1 {
		t.Fatalf("different payload should get different id")
	}
}

// ---------------------------------------------------------------------------
// Case 4 — Concurrent enqueues don't corrupt state.
// ---------------------------------------------------------------------------

func TestConcurrentEnqueue(t *testing.T) {
	q, _, cleanup := testQueue(t)
	defer cleanup()
	ctx := context.Background()

	const workers = 8
	const each = 25
	var wg sync.WaitGroup
	wg.Add(workers)
	for w := 0; w < workers; w++ {
		w := w
		go func() {
			defer wg.Done()
			for i := 0; i < each; i++ {
				taskID := "task-w" + itoa(w) + "-" + itoa(i)
				if _, err := q.Enqueue(ctx, taskID,
					[]byte(taskID)); err != nil {
					t.Errorf("concurrent Enqueue: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()
	st, err := q.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Total != int64(workers*each) {
		t.Fatalf("expected %d total rows, got %+v", workers*each, st)
	}
}

// ---------------------------------------------------------------------------
// Case 5 — Dequeue returns items in FIFO order and flips status.
// ---------------------------------------------------------------------------

func TestDequeueOrdering(t *testing.T) {
	q, _, cleanup := testQueue(t)
	defer cleanup()
	ctx := context.Background()

	var ids []int64
	for i := 0; i < 5; i++ {
		id, err := q.Enqueue(ctx, "task-o-"+itoa(i),
			[]byte("p-"+itoa(i)))
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	items, err := q.Dequeue(ctx, 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 {
		t.Fatalf("expected 3, got %d", len(items))
	}
	for i, it := range items {
		if it.ID != ids[i] {
			t.Fatalf("want id[%d]=%d, got %d", i, ids[i], it.ID)
		}
	}
}

// ---------------------------------------------------------------------------
// Case 6 — Schema migration is idempotent across Open cycles.
// ---------------------------------------------------------------------------

func TestMigrationIdempotent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "queue.db")

	q1, err := Open(Config{Path: path})
	if err != nil {
		t.Fatalf("Open 1: %v", err)
	}
	ctx := context.Background()
	if _, err := q1.Enqueue(ctx, "t", []byte("hello")); err != nil {
		t.Fatal(err)
	}
	if err := q1.Close(); err != nil {
		t.Fatalf("Close 1: %v", err)
	}

	q2, err := Open(Config{Path: path})
	if err != nil {
		t.Fatalf("Open 2 (re-open): %v", err)
	}
	defer q2.Close()
	st, _ := q2.Stats(ctx)
	if st.Queued != 1 {
		t.Fatalf("expected row to persist across open cycles, got %+v", st)
	}
}

// ---------------------------------------------------------------------------
// Case 7 — Second Open fails with ErrLocked (Unix only).
// ---------------------------------------------------------------------------

func TestExclusiveLock(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("flock is a no-op on Windows")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "queue.db")
	q1, err := Open(Config{Path: path})
	if err != nil {
		t.Fatalf("Open 1: %v", err)
	}
	defer q1.Close()

	_, err = Open(Config{Path: path})
	if err == nil {
		t.Fatalf("second Open should fail with ErrLocked")
	}
	if err != ErrLocked {
		t.Fatalf("expected ErrLocked, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// Case 8 — ReclaimUploading rescues stranded rows on re-open.
// ---------------------------------------------------------------------------

func TestReclaimUploading(t *testing.T) {
	q, _, cleanup := testQueue(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := q.Enqueue(ctx, "t-a", []byte("a")); err != nil {
		t.Fatal(err)
	}
	items, _ := q.Dequeue(ctx, 10)
	if len(items) != 1 {
		t.Fatalf("expected 1 dequeued, got %d", len(items))
	}
	// Do NOT mark — simulate crash while uploading.
	n, err := q.ReclaimUploading(ctx)
	if err != nil {
		t.Fatalf("ReclaimUploading: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 reclaimed, got %d", n)
	}
	items, _ = q.Dequeue(ctx, 10)
	if len(items) != 1 {
		t.Fatalf("reclaim should make row queue-visible again, got %d",
			len(items))
	}
}

// ---------------------------------------------------------------------------
// Case 9 — Prune removes uploaded rows older than cutoff; keeps dropped.
// ---------------------------------------------------------------------------

func TestPrune(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "queue.db")
	// Very short prune window so we can test without sleeping for days.
	q, err := Open(Config{Path: path, PruneAfter: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	ctx := context.Background()

	// Uploaded row — eligible for prune.
	idA, _ := q.Enqueue(ctx, "t-prune-a", []byte("a"))
	items, _ := q.Dequeue(ctx, 10)
	if items[0].ID != idA {
		t.Fatalf("unexpected id")
	}
	if err := q.MarkUploaded(ctx, idA); err != nil {
		t.Fatal(err)
	}

	// Dropped row — NEVER pruned.
	idB, _ := q.Enqueue(ctx, "t-prune-b", []byte("b"))
	if err := q.ForceDropped(ctx, idB, "operator-drop"); err != nil {
		t.Fatal(err)
	}

	// Queued row — not eligible (only uploaded is pruned).
	_, _ = q.Enqueue(ctx, "t-prune-c", []byte("c"))

	time.Sleep(50 * time.Millisecond)

	deleted, err := q.Prune(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 1 {
		t.Fatalf("expected 1 deletion (uploaded only), got %d", deleted)
	}
	st, _ := q.Stats(ctx)
	if st.Uploaded != 0 {
		t.Fatalf("uploaded should be pruned, got %+v", st)
	}
	if st.Dropped != 1 {
		t.Fatalf("dropped must be preserved for audit, got %+v", st)
	}
	if st.Queued != 1 {
		t.Fatalf("queued must stay, got %+v", st)
	}
}

// ---------------------------------------------------------------------------
// Case 10 — Enqueue rejects empty inputs.
// ---------------------------------------------------------------------------

func TestEnqueueValidation(t *testing.T) {
	q, _, cleanup := testQueue(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := q.Enqueue(ctx, "", []byte("x")); err == nil {
		t.Fatal("expected err for empty taskID")
	}
	if _, err := q.Enqueue(ctx, "t", nil); err == nil {
		t.Fatal("expected err for nil payload")
	}
}

// ---------------------------------------------------------------------------
// Case 11 — Operations on a closed queue return ErrClosed.
// ---------------------------------------------------------------------------

func TestClosedQueue(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "queue.db")
	q, err := Open(Config{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	if err := q.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	ctx := context.Background()
	if _, err := q.Enqueue(ctx, "t", []byte("x")); err != ErrClosed {
		t.Fatalf("expected ErrClosed, got %v", err)
	}
	if _, err := q.Stats(ctx); err != ErrClosed {
		t.Fatalf("expected ErrClosed, got %v", err)
	}
	// Double-close is safe.
	if err := q.Close(); err != nil {
		t.Fatalf("double-close: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Case 12 — DB path is created if parent dir missing.
// ---------------------------------------------------------------------------

func TestMkdirParent(t *testing.T) {
	dir := t.TempDir()
	nested := filepath.Join(dir, "does", "not", "exist", "queue.db")
	q, err := Open(Config{Path: nested})
	if err != nil {
		t.Fatalf("Open with missing parent: %v", err)
	}
	defer q.Close()
	if _, err := os.Stat(nested); err != nil {
		t.Fatalf("expected db file to exist: %v", err)
	}
}

func TestTerminalTransitionsAreIdempotentAndDoNotCross(t *testing.T) {
	q, _, cleanup := testQueue(t)
	defer cleanup()
	ctx := context.Background()

	uploadedID, err := q.Enqueue(ctx, "terminal-uploaded", []byte("uploaded"))
	if err != nil {
		t.Fatal(err)
	}
	if err := q.MarkUploaded(ctx, uploadedID); err != nil {
		t.Fatal(err)
	}
	if err := q.MarkUploaded(ctx, uploadedID); err != nil {
		t.Fatalf("idempotent MarkUploaded: %v", err)
	}
	if err := q.ForceDropped(ctx, uploadedID, "must-not-cross"); err == nil {
		t.Fatal("ForceDropped must not overwrite uploaded")
	}

	droppedID, err := q.Enqueue(ctx, "terminal-dropped", []byte("dropped"))
	if err != nil {
		t.Fatal(err)
	}
	if err := q.ForceDropped(ctx, droppedID, "fatal"); err != nil {
		t.Fatal(err)
	}
	if err := q.ForceDropped(ctx, droppedID, "fatal-repeat"); err != nil {
		t.Fatalf("idempotent ForceDropped: %v", err)
	}
	if err := q.MarkUploaded(ctx, droppedID); err == nil {
		t.Fatal("MarkUploaded must not resurrect dropped")
	}
	if !errors.Is(q.MarkUploaded(ctx, 999999), ErrNotFound) {
		t.Fatal("missing MarkUploaded id must return ErrNotFound")
	}
	if !errors.Is(q.ForceDropped(ctx, 999999, "missing"), ErrNotFound) {
		t.Fatal("missing ForceDropped id must return ErrNotFound")
	}

	st, err := q.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Uploaded != 1 || st.Dropped != 1 {
		t.Fatalf("terminal states crossed: %+v", st)
	}
}

func TestTerminalTransitionsRespectContextWhileWaitingForWriter(t *testing.T) {
	q, _, cleanup := testQueue(t)
	defer cleanup()
	ctx := context.Background()
	id, err := q.Enqueue(ctx, "terminal-lock", []byte("payload"))
	if err != nil {
		t.Fatal(err)
	}

	assertBounded := func(name string, transition func(context.Context) error) {
		t.Helper()
		if err := q.writeMu.Lock(context.Background()); err != nil {
			t.Fatal(err)
		}
		deadlineCtx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		started := time.Now()
		err := transition(deadlineCtx)
		elapsed := time.Since(started)
		cancel()
		q.writeMu.Unlock()
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("%s: expected deadline exceeded, got %v", name, err)
		}
		if elapsed > 500*time.Millisecond {
			t.Fatalf("%s: writer wait exceeded bound: %s", name, elapsed)
		}
	}

	assertBounded("MarkUploaded", func(callCtx context.Context) error {
		return q.MarkUploaded(callCtx, id)
	})
	assertBounded("ForceDropped", func(callCtx context.Context) error {
		return q.ForceDropped(callCtx, id, "bounded")
	})
}

func TestRequeueUploadingTargetsOnlyClaimedIDs(t *testing.T) {
	q, _, cleanup := testQueue(t)
	defer cleanup()
	ctx := context.Background()
	for index := 0; index < 4; index++ {
		if _, err := q.Enqueue(ctx, "requeue-"+itoa(index), []byte{byte(index + 1)}); err != nil {
			t.Fatal(err)
		}
	}
	items, err := q.Dequeue(ctx, 4)
	if err != nil || len(items) != 4 {
		t.Fatalf("Dequeue: err=%v len=%d", err, len(items))
	}
	if err := q.MarkUploaded(ctx, items[0].ID); err != nil {
		t.Fatal(err)
	}
	ids := []int64{items[1].ID, items[2].ID, items[2].ID}
	if err := q.RequeueUploading(ctx, ids); err != nil {
		t.Fatal(err)
	}
	if err := q.RequeueUploading(ctx, ids); err != nil {
		t.Fatalf("idempotent requeue: %v", err)
	}
	if err := q.RequeueUploading(ctx, []int64{items[0].ID}); err != nil {
		t.Fatalf("terminal requeue must be a no-op, got %v", err)
	}
	st, err := q.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Uploaded != 1 || st.Queued != 2 || st.Uploading != 1 {
		t.Fatalf("unexpected targeted requeue state: %+v", st)
	}
	if items[3].Status != StatusUploading {
		t.Fatalf("unlisted claimed row changed in memory: %+v", items[3])
	}
}

// Small helper to avoid dragging strconv into every test call site.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
