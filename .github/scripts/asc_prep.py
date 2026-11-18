# Attaches the newest finished build to each app's 1.0 version and fills StarTier's / Slide Thru's reviewer notes.
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
    print(" ", m, path.split("?")[0], r.status_code, "" if r.status_code < 400 else r.text[:500])
    return r
NOTES = {k: open(f".github/scripts/notes-{k}.txt").read() for k in ["startier", "slidethru"]}
for bundle, key in [("app.startier", "startier"), ("com.kingjordanmedia.slidethru", "slidethru"), ("com.kingjordanmedia.bookedup", None)]:
    aid = call("GET", f"/v1/apps?filter[bundleId]={bundle}").json()["data"][0]["id"]
    print("==", bundle)
    v = call("GET", f"/v1/apps/{aid}/appStoreVersions?limit=1").json()["data"][0]
    b = next((b for b in call("GET", f"/v1/builds?filter[app]={aid}&sort=-uploadedDate&limit=5").json()["data"] if b["attributes"]["processingState"] == "VALID"), None)
    if b:
        call("PATCH", f"/v1/appStoreVersions/{v['id']}/relationships/build", {"data": {"type": "builds", "id": b["id"]}})
        print("  attached build", b["attributes"]["version"])
    rd = call("GET", f"/v1/appStoreVersions/{v['id']}/appStoreReviewDetail").json().get("data")
    if key and rd:
        call("PATCH", f"/v1/appStoreReviewDetails/{rd['id']}", {"data": {"type": "appStoreReviewDetails", "id": rd["id"], "attributes": {"notes": NOTES[key]}}})
    if rd and not key:
        print("  BookedUp current notes:\n" + (rd["attributes"].get("notes") or ""))
