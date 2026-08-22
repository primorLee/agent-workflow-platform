package ulid

import (
	"sort"
	"testing"
)

func TestNewProducesValidULID(t *testing.T) {
	id := New()
	if len(id) != 26 {
		t.Fatalf("ULID length = %d, want 26; got %q", len(id), id)
	}
	if !IsValid(id) {
		t.Fatalf("ULID not valid: %q", id)
	}
}

func TestMonotonicWithinSameMillisecond(t *testing.T) {
	const N = 1000
	ids := make([]string, N)
	for i := range ids {
		ids[i] = New()
	}
	sorted := append([]string(nil), ids...)
	sort.Strings(sorted)
	for i := range ids {
		if ids[i] != sorted[i] {
			t.Fatalf("ULIDs not monotonic at %d", i)
		}
	}
}

func TestIsValidRejectsBadInput(t *testing.T) {
	for _, bad := range []string{"", "short", "not-a-ulid-at-all", "00000000000000000000000000I"} {
		if IsValid(bad) {
			t.Errorf("IsValid should reject %q", bad)
		}
	}
}
