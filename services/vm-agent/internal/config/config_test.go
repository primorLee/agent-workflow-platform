package config

import (
	"strings"
	"testing"
)

func TestValidateServerURL(t *testing.T) {
	tests := []struct {
		name      string
		serverURL string
		wantErr   bool
	}{
		{name: "secure DNS", serverURL: "wss://broker.example.com/agent/connect"},
		{name: "secure IPv4", serverURL: "wss://192.0.2.20:443/agent/connect"},
		{name: "secure public IPv6", serverURL: "wss://[2001:db8::1]:443/agent/connect"},
		{name: "secure mapped IPv4 URL ambiguity", serverURL: "wss://[::ffff:192.0.2.20]/agent/connect", wantErr: true},
		{name: "secure single label", serverURL: "wss://broker/agent/connect"},
		{name: "localhost", serverURL: "ws://localhost:8100/agent/connect"},
		{name: "localhost case insensitive", serverURL: "ws://LOCALHOST/agent/connect"},
		{name: "IPv4 loopback", serverURL: "ws://127.0.0.1:8100/agent/connect"},
		{name: "IPv4 loopback full range", serverURL: "ws://127.255.255.254/agent/connect"},
		{name: "IPv6 loopback", serverURL: "ws://[::1]:8100/agent/connect"},
		{name: "mapped IPv4 URL ambiguity", serverURL: "ws://[::ffff:127.0.0.42]/agent/connect", wantErr: true},

		{name: "HTTP scheme", serverURL: "http://localhost/agent/connect", wantErr: true},
		{name: "scheme relative", serverURL: "//localhost/agent/connect", wantErr: true},
		{name: "opaque URL", serverURL: "ws:localhost", wantErr: true},
		{name: "missing host", serverURL: "ws:///agent/connect", wantErr: true},
		{name: "userinfo local", serverURL: "ws://user:password@localhost/agent/connect", wantErr: true},
		{name: "userinfo secure", serverURL: "wss://user:password@broker.example/agent/connect", wantErr: true},
		{name: "fragment", serverURL: "ws://localhost/agent/connect#fragment", wantErr: true},
		{name: "leading whitespace", serverURL: " ws://localhost/agent/connect", wantErr: true},
		{name: "empty port", serverURL: "ws://localhost:/agent/connect", wantErr: true},
		{name: "non numeric port", serverURL: "ws://localhost:abc/agent/connect", wantErr: true},
		{name: "zero port", serverURL: "ws://localhost:0/agent/connect", wantErr: true},
		{name: "port out of range", serverURL: "ws://localhost:65536/agent/connect", wantErr: true},
		{name: "bare IPv6", serverURL: "ws://::1:8100/agent/connect", wantErr: true},
		{name: "IPv6 zone", serverURL: "ws://[::1%25loopback]:8100/agent/connect", wantErr: true},
		{name: "bracketed IPv4", serverURL: "ws://[127.0.0.1]:8100/agent/connect", wantErr: true},
		{name: "fake localhost suffix", serverURL: "ws://localhost.evil/agent/connect", wantErr: true},
		{name: "fake localhost prefix", serverURL: "ws://evil-localhost/agent/connect", wantErr: true},
		{name: "localhost trailing dot", serverURL: "ws://localhost./agent/connect", wantErr: true},
		{name: "non loopback IPv4", serverURL: "ws://192.0.2.10/agent/connect", wantErr: true},
		{name: "non loopback IPv6", serverURL: "ws://[2001:db8::1]/agent/connect", wantErr: true},
		{name: "short IPv4 ambiguity", serverURL: "ws://127.1/agent/connect", wantErr: true},
		{name: "integer IPv4 ambiguity", serverURL: "ws://2130706433/agent/connect", wantErr: true},
		{name: "leading zero IPv4 ambiguity", serverURL: "ws://0177.0.0.1/agent/connect", wantErr: true},
		{name: "invalid DNS label", serverURL: "wss://broker_name.example/agent/connect", wantErr: true},
		{name: "empty DNS label", serverURL: "wss://broker..example/agent/connect", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := Config{APIKey: "test-token", ServerURL: tt.serverURL}
			err := cfg.validate()
			if tt.wantErr && err == nil {
				t.Fatal("expected validation error")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("unexpected validation error: %v", err)
			}
		})
	}
}

func TestValidateErrorsDoNotLeakCredentials(t *testing.T) {
	const secret = "credential-fixture-do-not-echo"
	tests := []Config{
		{APIKey: secret, ServerURL: "ws://user:" + secret + "@localhost/agent/connect"},
		{APIKey: secret, ServerURL: "ws://localhost.evil/" + secret},
		{APIKey: secret, ServerURL: "not-a-url-" + secret},
		{APIKey: secret, ServerURL: "wss://broker.example", TLSCertPin: secret},
	}
	for _, cfg := range tests {
		err := cfg.validate()
		if err == nil {
			t.Fatal("expected validation error")
		}
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("validation error leaked credential fixture: %q", err.Error())
		}
	}
}
