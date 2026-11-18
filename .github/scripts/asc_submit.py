# Sends each app named in SUBMIT (comma list of bundle ids) to App Review.
import os, time, json, jwt, requests
KEY_ID, ISSUER, P8 = os.environ["ASC_KEY_ID"], os.environ["ASC_ISSUER_ID"], os.environ["ASC_KEY_P8"]
B = "https://api.appstoreconnect.apple.com"
now = int(time.time()) - 60
TOKEN = jwt.encode({"iss": ISSUER, "iat": now, "exp": now + 1100, "aud": "appstoreconnect-v1"}, P8, algorithm="ES256", headers={"kid": KEY_ID, "typ": "JWT"})
def call(m, path, body=None):
    for a in range(6):
        r = requests.request(m, B + path, headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}, data=json.dumps(body) if body else None)
        if r.status_code != 401: break
        time.sleep(4 * (a + 1))
    print(" ", m, path.split("?")[0], r.status_code, "" if r.status_code < 400 else r.text[:1500])
    return r
for bundle in [b.strip() for b in os.environ["SUBMIT"].split(",") if b.strip()]:
    print("==", bundle)
    aid = call("GET", f"/v1/apps?filter[bundleId]={bundle}").json()["data"][0]["id"]
    v = call("GET", f"/v1/apps/{aid}/appStoreVersions?limit=1").json()["data"][0]
    print("  version state", v["attributes"]["appStoreState"])
    subs = call("GET", f"/v1/reviewSubmissions?filter[app]={aid}&filter[platform]=IOS&limit=10").json()["data"]
    for s in subs: print("  existing submission", s["id"], s["attributes"]["state"])
    sub = next((s for s in subs if s["attributes"]["state"] in ("READY_FOR_REVIEW", "UNRESOLVED_ISSUES")), None)
    if not sub:
        r = call("POST", "/v1/reviewSubmissions", {"data": {"type": "reviewSubmissions", "attributes": {"platform": "IOS"}, "relationships": {"app": {"data": {"type": "apps", "id": aid}}}}})
        if r.status_code >= 400: continue
        sub = r.json()["data"]
    items = call("GET", f"/v1/reviewSubmissions/{sub['id']}/items").json().get("data", [])
    if not items:
        call("POST", "/v1/reviewSubmissionItems", {"data": {"type": "reviewSubmissionItems", "relationships": {
            "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": sub["id"]}}, "appStoreVersion": {"data": {"type": "appStoreVersions", "id": v["id"]}}}}})
    r = call("PATCH", f"/v1/reviewSubmissions/{sub['id']}", {"data": {"type": "reviewSubmissions", "id": sub["id"], "attributes": {"submitted": True}}})
    if r.status_code < 400: print("  SUBMITTED", r.json()["data"]["attributes"]["state"])
