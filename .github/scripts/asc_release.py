# Sets each app's version that is waiting for or in review to release automatically as soon as Apple approves it.
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
    if r.status_code >= 400: print("  !", m, path.split("?")[0], r.status_code, r.text[:500])
    return r
OPEN = {"WAITING_FOR_REVIEW", "IN_REVIEW", "PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW", "PENDING_DEVELOPER_RELEASE"}
for bundle in ["app.startier", "com.kingjordanmedia.slidethru", "com.kingjordanmedia.bookedup"]:
    app = call("GET", f"/v1/apps?filter[bundleId]={bundle}").json()["data"][0]
    print("\n==", app["attributes"]["name"])
    for v in call("GET", f"/v1/apps/{app['id']}/appStoreVersions?limit=3").json()["data"]:
        a = v["attributes"]; state = a["appStoreState"]
        print("  version", a["versionString"], state, "| release:", a.get("releaseType"))
        if state not in OPEN: continue
        if state == "PENDING_DEVELOPER_RELEASE":
            print("  already approved and waiting on you: not changed")
            continue
        if a.get("releaseType") != "AFTER_APPROVAL":
            r = call("PATCH", f"/v1/appStoreVersions/{v['id']}", {"data": {"type": "appStoreVersions", "id": v["id"], "attributes": {"releaseType": "AFTER_APPROVAL"}}})
            print("  set to release automatically after approval:", r.status_code, r.ok and r.json()["data"]["attributes"].get("releaseType"))
