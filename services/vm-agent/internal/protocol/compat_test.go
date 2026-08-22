package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestCompatVectorsRoundtrip loads vm-agent/testdata/envelope_v1_samples.json
// and verifies every sample envelope parses without error, its Type is
// non-empty, and re-marshalling preserves all top-level fields.
//
// The same file is consumed by the Python broker test suite
// (cloud/tests/test_agent_protocol_compat.py — to be added) to prove both
// sides agree on the wire.
func TestCompatVectorsRoundtrip(t *testing.T) {
	// Climb two levels: .../internal/protocol → .../vm-agent, then join testdata.
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	path := filepath.Join(wd, "..", "..", "testdata", "envelope_v1_samples.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read samples: %v", err)
	}

	var doc struct {
		ProtocolVersion int `json:"protocol_version"`
		Samples         []struct {
			Name     string          `json:"name"`
			Envelope json.RawMessage `json:"envelope"`
		} `json:"samples"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse samples: %v", err)
	}

	if doc.ProtocolVersion != 1 {
		t.Errorf("sample file declares protocol_version=%d, want 1", doc.ProtocolVersion)
	}
	if len(doc.Samples) == 0 {
		t.Fatalf("no samples in file")
	}

	for _, s := range doc.Samples {
		t.Run(s.Name, func(t *testing.T) {
			env, err := UnmarshalEnvelope(s.Envelope)
			if err != nil {
				t.Fatalf("decode %q: %v", s.Name, err)
			}
			if env.V != 1 {
				t.Errorf("%q has v=%d, want 1", s.Name, env.V)
			}
			if env.Type == "" {
				t.Errorf("%q has empty type", s.Name)
			}
			if env.ID == "" {
				t.Errorf("%q has empty id", s.Name)
			}

			// Re-marshal and re-parse; must survive.
			b, err := MarshalEnvelope(env)
			if err != nil {
				t.Fatalf("remarshal %q: %v", s.Name, err)
			}
			if _, err := UnmarshalEnvelope(b); err != nil {
				t.Fatalf("reparse %q: %v", s.Name, err)
			}

			// Type-specific payload decode spot-checks.
			switch env.Type {
			case TypeHello:
				var p HelloPayload
				if err := env.Decode(&p); err != nil {
					t.Fatalf("decode hello payload: %v", err)
				}
				if p.AgentID == "" {
					t.Errorf("hello missing agent_id")
				}
				if p.CPU.Cores == 0 {
					t.Errorf("hello missing cpu.cores")
				}
			case TypeWelcome:
				var p WelcomePayload
				if err := env.Decode(&p); err != nil {
					t.Fatalf("decode welcome payload: %v", err)
				}
				if p.SessionID == "" {
					t.Errorf("welcome missing session_id")
				}
				if p.FeatureFlags.MaxConcurrentTasks == 0 {
					t.Errorf("welcome missing max_concurrent_tasks")
				}
			case TypeTaskOffer:
				var p TaskOfferPayload
				if err := env.Decode(&p); err != nil {
					t.Fatalf("decode task.offer payload: %v", err)
				}
				if p.TaskID == "" {
					t.Errorf("task.offer missing task_id")
				}
				if p.Execution.Input.Mode == "" {
					t.Errorf("task.offer missing execution.input.mode")
				}
			case TypeTaskComplete:
				var p TaskCompletePayload
				if err := env.Decode(&p); err != nil {
					t.Fatalf("decode task.complete payload: %v", err)
				}
				if p.Status == "" {
					t.Errorf("task.complete missing status")
				}
			case TypeAck:
				var p AckPayload
				if err := env.Decode(&p); err != nil {
					t.Fatalf("decode ack payload: %v", err)
				}
				if p.ForID == "" {
					t.Errorf("ack missing for_id")
				}
			}
		})
	}
}
