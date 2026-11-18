# Makes sure the Apple account has at least one test device, which Apple needs before it will sign a test copy.
# BrowserStack re-signs uploaded apps with its own certificate, so this entry is only a placeholder.
import os, time, json, jwt, requests
KEY_ID, ISSUER, P8 = os.environ["ASC_KEY_ID"], os.environ["ASC_ISSUER_ID"], os.environ["ASC_KEY_P8"]
if "BEGIN PRIVATE KEY" not in P8:  # only the key's middle lines were saved; add the BEGIN/END lines
    import re, textwrap; b = re.sub(r"\s+", "", P8); P8 = "-----BEGIN PRIVATE KEY-----\n" + "\n".join(textwrap.wrap(b, 64)) + "\n-----END PRIVATE KEY-----\n"
now = int(time.time()) - 60
T = jwt.encode({"iss": ISSUER, "iat": now, "exp": now + 1100, "aud": "appstoreconnect-v1"}, P8, algorithm="ES256", headers={"kid": KEY_ID, "typ": "JWT"})
def call(m, p, b=None):
    for a in range(6):
        r = requests.request(m, "https://api.appstoreconnect.apple.com" + p, headers={"Authorization": "Bearer " + T, "Content-Type": "application/json"}, data=json.dumps(b) if b else None)
        if r.status_code != 401: return r
        time.sleep(4 * (a + 1))
    return r
devs = call("GET", "/v1/devices?filter[platform]=IOS&filter[status]=ENABLED&limit=5").json().get("data", [])
print("Registered test devices:", len(devs))
if not devs:
    r = call("POST", "/v1/devices", {"data": {"type": "devices", "attributes": {"name": "BrowserStack placeholder", "platform": "IOS", "udid": "00008110-000A1B2C3D4E801E"}}})
    print("Added placeholder device:", r.status_code, r.text[:300])
