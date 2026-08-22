// Package ulid generates ULIDs (Crockford base32, 26 chars, monotonic) for
// use as envelope IDs. Wraps github.com/oklog/ulid/v2 with a process-wide
// monotonic entropy source so frames emitted in a tight loop still sort in
// generation order.
//
// See spec §2.1 rule 2: envelope IDs MUST be ULIDs.
package ulid

import (
	"crypto/rand"
	"io"
	"sync"
	"time"

	oklog "github.com/oklog/ulid/v2"
)

var (
	mu      sync.Mutex
	entropy io.Reader
)

func init() {
	// Monotonic reader guarantees strictly-increasing IDs within the same
	// millisecond, which matters when two frames (e.g. ack + progress) are
	// emitted back-to-back.
	entropy = oklog.Monotonic(rand.Reader, 0)
}

// New returns a fresh ULID string (26 chars, Crockford base32).
func New() string {
	mu.Lock()
	defer mu.Unlock()
	return oklog.MustNew(oklog.Timestamp(time.Now()), entropy).String()
}

// IsValid reports whether s is a syntactically valid ULID.
func IsValid(s string) bool {
	_, err := oklog.Parse(s)
	return err == nil
}
