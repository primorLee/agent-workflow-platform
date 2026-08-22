package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestEnvelopeRoundtrip(t *testing.T) {
	original := &Envelope{
		V:    1,
		Type: TypeHello,
		ID:   "01HX8F3ABCDEFGHJKMNPQRSTVW",
		TS:   1713542400.123,
		Payload: mustMarshal(t, map[string]any{
			"agent_id":      "agt_01HX123",
			"agent_version": "1.4.19",
		}),
	}

	raw, err := MarshalEnvelope(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	round, err := UnmarshalEnvelope(raw)
	if err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if round.V != 1 {
		t.Errorf("v = %d, want 1", round.V)
	}
	if round.Type != TypeHello {
		t.Errorf("type = %q, want hello", round.Type)
	}
	if round.ID != original.ID {
		t.Errorf("id mismatch: got %q, want %q", round.ID, original.ID)
	}
	if round.TS != original.TS {
		t.Errorf("ts mismatch")
	}
}

func TestEnvelopeRejectsMissingFields(t *testing.T) {
	_, err := UnmarshalEnvelope([]byte(`{"v":1,"ts":123,"payload":{}}`))
	if err == nil {
		t.Errorf("expected error on missing type")
	}
	_, err = UnmarshalEnvelope([]byte(`{"v":1,"type":"hello","ts":123,"payload":{}}`))
	if err == nil {
		t.Errorf("expected error on missing id")
	}
}

func TestEnvelopePreservesUnknownFields(t *testing.T) {
	// The spec requires unknown top-level fields to be ignored on consumption.
	// Our struct drops them, which is fine because we never re-forward
	// received envelopes — we only react. But we MUST NOT fail to parse.
	raw := `{"v":1,"type":"hello","id":"01HX8F3ABCDEFGHJKMNPQRSTVW","ts":1.5,"payload":{},"future_field":42}`
	env, err := UnmarshalEnvelope([]byte(raw))
	if err != nil {
		t.Fatalf("should tolerate unknown field: %v", err)
	}
	if env.Type != TypeHello {
		t.Errorf("unexpected type %q", env.Type)
	}
}

func TestHelloPayloadMarshal(t *testing.T) {
	hp := HelloPayload{
		AgentID:            "agt_abc",
		AgentVersion:       "1.4.19+sha.deadbeef",
		ProtocolVersions:   []int{1},
		MinProtocolVersion: 1,
		Distro:             "Ubuntu 24.04.1 LTS",
		DistroID:           "ubuntu",
		DistroVersion:      "24.04",
		Kernel:             "6.8.0-45-generic",
		Arch:               "x86_64",
		CPU:                CPUInfo{Model: "Xeon Gold 6230", Cores: 20, Threads: 40},
		MemKB:              134217728,
		RuntimeVersion:     "IC23.1",
		RunnerVersion:      "23.1.0.403",
		RuntimeList:        []string{"python3"},
		Features:           []string{"echo"},
		Timezone:           "Asia/Shanghai",
		BootID:             "6e4f",
		StartTime:          1713530000,
	}
	b, err := json.Marshal(hp)
	if err != nil {
		t.Fatalf("marshal hello: %v", err)
	}
	s := string(b)
	for _, want := range []string{`"agent_id":"agt_abc"`, `"cores":20`, `"threads":40`, `"mem_kb":134217728`} {
		if !strings.Contains(s, want) {
			t.Errorf("hello JSON missing %q:\n%s", want, s)
		}
	}
}

func TestWelcomePayloadDecode(t *testing.T) {
	raw := `{
		"server_version":"awp-cloud 1.4.19",
		"protocol_version":1,
		"min_protocol_version":1,
		"required_agent_version":"1.4.10",
		"session_id":"sess_abc",
		"session_ttl_s":3600,
		"feature_flags":{
			"mtls_required":false,
			"artifact_signed_urls":true,
			"log_streaming":true,
			"multi_task":true,
			"max_concurrent_tasks":4,
			"transport":["wss","longpoll"]
		},
		"heartbeat_interval_s":30,
		"heartbeat_grace_s":90,
		"clock_skew_max_s":300
	}`
	var w WelcomePayload
	if err := json.Unmarshal([]byte(raw), &w); err != nil {
		t.Fatalf("decode welcome: %v", err)
	}
	if w.FeatureFlags.MaxConcurrentTasks != 4 {
		t.Errorf("max_concurrent_tasks = %d", w.FeatureFlags.MaxConcurrentTasks)
	}
	if len(w.FeatureFlags.Transport) != 2 {
		t.Errorf("transport = %v", w.FeatureFlags.Transport)
	}
	if w.RequiredAgentVersion != "1.4.10" {
		t.Errorf("required_agent_version = %q", w.RequiredAgentVersion)
	}
}

func TestTaskOfferPayloadRoundtrip(t *testing.T) {
	offer := TaskOfferPayload{
		TaskID:         "task_01",
		IdempotencyKey: "idem_01",
		TenantID:       "tenant_01",
		Priority:       5,
		TimeoutSec:     2700,
		Execution: ExecutionSpec{
			Runner:     "echo",
			Runtime:    "python3",
			Action:     "inspect",
			Outputs:    []string{"stdout"},
			Parameters: map[string]interface{}{"message": "hello", "retries": 1},
			Input: InputSpec{
				Mode:   "inline",
				Inline: "synthetic input",
			},
			Options:  map[string]string{"format": "plain"},
			Includes: []ArtifactRef{},
		},
		Constraints: TaskConstraints{MinMemKB: 4194304},
		Trace:       TaskTrace{TraceID: "abc", ParentSpanID: "def"},
	}
	b, err := json.Marshal(offer)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back TaskOfferPayload
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.Execution.Input.Mode != "inline" {
		t.Errorf("mode = %q", back.Execution.Input.Mode)
	}
	if back.Execution.Input.Inline != "synthetic input" {
		t.Errorf("inline = %q", back.Execution.Input.Inline)
	}
	if back.Constraints.MinMemKB != 4194304 {
		t.Errorf("min_mem_kb = %d", back.Constraints.MinMemKB)
	}
}

func TestTypeIsError(t *testing.T) {
	cases := []struct {
		t    Type
		want bool
	}{
		{TypeError, true},
		{"err.auth.invalid_credentials", true},
		{"err.protocol.clock_skew", true},
		{TypeHello, false},
		{TypeTaskOffer, false},
		{TypeAck, false},
	}
	for _, c := range cases {
		if got := c.t.IsError(); got != c.want {
			t.Errorf("%q.IsError() = %v, want %v", c.t, got, c.want)
		}
	}
}

func TestAckPayloadSerialization(t *testing.T) {
	a := AckPayload{ForID: "01HXABC", Seq: 5, Window: 64}
	b, _ := json.Marshal(a)
	if !strings.Contains(string(b), `"for_id":"01HXABC"`) {
		t.Errorf("ack JSON missing for_id: %s", b)
	}
	if !strings.Contains(string(b), `"window":64`) {
		t.Errorf("ack JSON missing window: %s", b)
	}
}

func TestErrorPayloadRetryable(t *testing.T) {
	ep := ErrorPayload{
		Code:        "err.resource.slot_exhausted",
		Message:     "no slots",
		Retryable:   true,
		RetryAfterS: 30,
	}
	b, _ := json.Marshal(ep)
	var back ErrorPayload
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal err payload: %v", err)
	}
	if !back.Retryable {
		t.Errorf("retryable lost")
	}
	if back.RetryAfterS != 30 {
		t.Errorf("retry_after_s = %v", back.RetryAfterS)
	}
}

func TestNewEnvelopeFillsDefaults(t *testing.T) {
	env, err := NewEnvelope("01HX01", TypeHeartbeat, &HeartbeatPayload{UptimeSec: 42})
	if err != nil {
		t.Fatalf("NewEnvelope: %v", err)
	}
	if env.V != 1 {
		t.Errorf("v = %d", env.V)
	}
	if env.Type != TypeHeartbeat {
		t.Errorf("type = %q", env.Type)
	}
	if env.ID != "01HX01" {
		t.Errorf("id = %q", env.ID)
	}
	if env.TS == 0 {
		t.Errorf("ts not populated")
	}
	var p HeartbeatPayload
	if err := env.Decode(&p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if p.UptimeSec != 42 {
		t.Errorf("uptime lost: %v", p.UptimeSec)
	}
}

func TestNewEnvelopeEmptyPayload(t *testing.T) {
	env, err := NewEnvelope("id1", TypePing, nil)
	if err != nil {
		t.Fatalf("NewEnvelope(nil): %v", err)
	}
	if string(env.Payload) != `{}` {
		t.Errorf("empty payload should be {}, got %q", env.Payload)
	}
}

func mustMarshal(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("mustMarshal: %v", err)
	}
	return b
}
