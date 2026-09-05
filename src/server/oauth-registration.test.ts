import { describe, expect, it } from "vitest";
import { normalizeClientRegistration } from "./oauth-registration";

describe("normalizeClientRegistration", () => {
  const claudeCode = {
    client_name: "Claude Code",
    redirect_uris: ["http://localhost:53821/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };

  it("records a command-line connector as the native client it is", () => {
    expect(normalizeClientRegistration(claudeCode)).toEqual({ ...claudeCode, application_type: "native" });
    for (const uri of ["http://127.0.0.1:8080/cb", "http://[::1]:3000/cb", "http://localhost/cb"]) {
      expect((normalizeClientRegistration({ ...claudeCode, redirect_uris: [uri] }) as any).application_type, uri).toBe("native");
    }
  });

  it("leaves a stated type alone, whatever the redirects", () => {
    const stated = { ...claudeCode, application_type: "web" };
    expect(normalizeClientRegistration(stated)).toBe(stated);
  });

  it("leaves a web client, or a mixed one, to the provider's rules", () => {
    for (const uris of [
      ["https://chatgpt.com/connector_platform_oauth_redirect"],
      ["https://localhost:3000/cb"],
      ["http://localhost:3000/cb", "https://example.com/cb"],
      ["http://localhost.:3000/cb"],
      ["http://evil.example/cb"],
      [],
    ]) {
      const body = { ...claudeCode, redirect_uris: uris };
      expect(normalizeClientRegistration(body), JSON.stringify(uris)).toBe(body);
    }
  });

  it("passes anything that is not a registration object through", () => {
    for (const v of [null, "x", 3, [1], undefined]) expect(normalizeClientRegistration(v)).toBe(v);
  });
});
