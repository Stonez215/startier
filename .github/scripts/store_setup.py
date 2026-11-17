# Sets StarTier's App Store details through Apple's App Store Connect API (no website needed):
# privacy policy link, free price, and U.S.-only availability. Prints the account's app access too.
import os, time, json, sys, jwt, requests
KEY_ID, ISSUER, P8 = os.environ["ASC_KEY_ID"], os.environ["ASC_ISSUER_ID"], os.environ["ASC_KEY_P8"]
BUNDLE, PRIVACY = "app.startier", "https://startier.app/?legal=privacy"
B = "https://api.appstoreconnect.apple.com"
def tok():
    now = int(time.time()) - 60
    return jwt.encode({"iss": ISSUER, "iat": now, "exp": now + 1000, "aud": "appstoreconnect-v1"}, P8, algorithm="ES256", headers={"kid": KEY_ID, "typ": "JWT"})
TOKEN = tok()
def call(m, path, body=None):
    for attempt in range(6):
        r = requests.request(m, B + path, headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}, data=json.dumps(body) if body else None)
        if r.status_code != 401: break
        print(m, path.split("?")[0], "401, retrying"); time.sleep(5 * (attempt + 1))
    print(m, path.split("?")[0], r.status_code)
    if r.status_code >= 400: print(r.text[:1500])
    return r
ok = True
app = call("GET", f"/v1/apps?filter[bundleId]={BUNDLE}").json()["data"][0]["id"]
print("App id", app)
# 1. Privacy policy link
infos = call("GET", f"/v1/apps/{app}/appInfos").json()["data"]
for info in infos:
    for loc in call("GET", f"/v1/appInfos/{info['id']}/appInfoLocalizations").json()["data"]:
        r = call("PATCH", f"/v1/appInfoLocalizations/{loc['id']}", {"data": {"type": "appInfoLocalizations", "id": loc["id"], "attributes": {"privacyPolicyUrl": PRIVACY}}})
        ok &= r.status_code < 400
# 2. Free price
pts, url = [], f"/v1/apps/{app}/appPricePoints?filter[territory]=USA&limit=200"
while url:
    j = call("GET", url).json(); pts += j["data"]
    nxt = j.get("links", {}).get("next"); url = nxt.replace(B, "") if nxt else None
free = next(p["id"] for p in pts if float(p["attributes"]["customerPrice"]) == 0)
r = call("POST", "/v1/appPriceSchedules", {
  "data": {"type": "appPriceSchedules", "relationships": {
     "app": {"data": {"type": "apps", "id": app}},
     "baseTerritory": {"data": {"type": "territories", "id": "USA"}},
     "manualPrices": {"data": [{"type": "appPrices", "id": "${price1}"}]}}},
  "included": [{"type": "appPrices", "id": "${price1}", "attributes": {"startDate": None},
     "relationships": {"appPricePoint": {"data": {"type": "appPricePoints", "id": free}}}}]})
ok &= r.status_code < 400
# 3. United States only
r = call("POST", "/v2/appAvailabilities", {
  "data": {"type": "appAvailabilities", "attributes": {"availableInNewTerritories": False}, "relationships": {
     "app": {"data": {"type": "apps", "id": app}},
     "territoryAvailabilities": {"data": [{"type": "territoryAvailabilities", "id": "${usa}"}]}}},
  "included": [{"type": "territoryAvailabilities", "id": "${usa}", "attributes": {"available": True},
     "relationships": {"territory": {"data": {"type": "territories", "id": "USA"}}}}]})
ok &= r.status_code < 400
# 4. Who can see this app (the 'user access could not be saved' message)
for u in call("GET", "/v1/users?limit=50").json().get("data", []):
    a = u["attributes"]; print("User:", a.get("firstName"), a.get("lastName"), a.get("roles"), "allAppsVisible =", a.get("allAppsVisible"))
print("ALL DONE" if ok else "SOME STEPS FAILED (see above)")
sys.exit(0 if ok else 1)
