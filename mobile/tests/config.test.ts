import { apiBaseUrl } from "../src/config";

describe("API base URL", () => {
  it("defaults to next dev on the PC that serves the Expo bundle", () => {
    expect(apiBaseUrl(undefined, "192.168.1.10:8081")).toBe("http://192.168.1.10:3000");
    expect(apiBaseUrl("", "192.168.1.10:8081/--/")).toBe("http://192.168.1.10:3000");
  });

  it("uses EXPO_PUBLIC_API_BASE_URL when set", () => {
    expect(apiBaseUrl("http://192.168.1.20:3000/", "192.168.1.10:8081")).toBe("http://192.168.1.20:3000");
  });

  it("refuses a malformed value and has no deployed default", () => {
    expect(apiBaseUrl("ftp://host", undefined)).toBeNull();
    expect(apiBaseUrl("http://host/path", undefined)).toBeNull();
    expect(apiBaseUrl(undefined, undefined)).toBeNull();
    expect(apiBaseUrl(undefined, "bad host:8081")).toBeNull();
  });
});
