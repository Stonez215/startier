# Read-only status for all three apps + makes sure Ahmed is an internal TestFlight tester on each.
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
    if r.status_code >= 400: print("  !", m, path.split("?")[0], r.status_code, r.text[:400])
    return r
me = next(u for u in call("GET", "/v1/users?limit=50").json()["data"] if "ACCOUNT_HOLDER" in u["attributes"]["roles"])
email = me["attributes"]["username"]
for bundle in ["app.startier", "com.kingjordanmedia.slidethru", "com.kingjordanmedia.bookedup"]:
    app = call("GET", f"/v1/apps?filter[bundleId]={bundle}").json()["data"][0]; aid = app["id"]
    print("\n==", app["attributes"]["name"], bundle, aid)
    builds = call("GET", f"/v1/builds?filter[app]={aid}&sort=-uploadedDate&limit=3").json()["data"]
    for b in builds: print("  build", b["attributes"]["version"], b["attributes"]["processingState"], b["attributes"]["uploadedDate"][:16])
    vers = call("GET", f"/v1/apps/{aid}/appStoreVersions?limit=3").json()["data"]
    for v in vers:
        print("  version", v["attributes"]["versionString"], v["attributes"]["appStoreState"])
        vb = call("GET", f"/v1/appStoreVersions/{v['id']}/build").json().get("data")
        print("   attached build:", vb and vb["attributes"]["version"])
        for loc in call("GET", f"/v1/appStoreVersions/{v['id']}/appStoreVersionLocalizations").json()["data"]:
            sets = call("GET", f"/v1/appStoreVersionLocalizations/{loc['id']}/appScreenshotSets").json()["data"]
            print("   screenshots:", {s["attributes"]["screenshotDisplayType"]: len(call("GET", f"/v1/appScreenshotSets/{s['id']}/appScreenshots").json()["data"]) for s in sets})
            a = loc["attributes"]; print("   description set:", bool(a.get("description")), "| keywords:", bool(a.get("keywords")), "| support url:", a.get("supportUrl"))
        rd = call("GET", f"/v1/appStoreVersions/{v['id']}/appStoreReviewDetail").json().get("data")
        if rd:
            a = rd["attributes"]; print("   review: contact", a.get("contactEmail"), "| demo required", a.get("demoAccountRequired"), "| demo user", a.get("demoAccountName"), "| notes", len(a.get("notes") or ""), "chars")
        else: print("   review details: none yet")
    groups = call("GET", f"/v1/apps/{aid}/betaGroups").json()["data"]
    internal = [g for g in groups if g["attributes"]["isInternalGroup"]]
    if not internal:
        g = call("POST", "/v1/betaGroups", {"data": {"type": "betaGroups", "attributes": {"name": "Team", "isInternalGroup": True, "hasAccessToAllBuilds": True}, "relationships": {"app": {"data": {"type": "apps", "id": aid}}}}}).json().get("data")
        internal = [g] if g else []
        print("  made internal TestFlight group:", bool(g))
    for g in internal:
        testers = call("GET", f"/v1/betaGroups/{g['id']}/betaTesters").json()["data"]
        if not any(t["attributes"].get("email", "").lower() == email.lower() for t in testers):
            r = call("POST", "/v1/betaTesters", {"data": {"type": "betaTesters", "attributes": {"email": email, "firstName": me["attributes"]["firstName"], "lastName": me["attributes"]["lastName"]}, "relationships": {"betaGroups": {"data": [{"type": "betaGroups", "id": g["id"]}]}}}})
            print("  added you as a TestFlight tester:", r.status_code)
        else: print("  you are already a TestFlight tester")
