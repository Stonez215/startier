# Uploads StarTier screenshots (replaces any already there). SHOT_SETS env: comma list of dir:displayType.
import os, glob, time, json, hashlib, jwt, requests
KEY_ID, ISSUER, P8 = os.environ["ASC_KEY_ID"], os.environ["ASC_ISSUER_ID"], os.environ["ASC_KEY_P8"]
B = "https://api.appstoreconnect.apple.com"
now = int(time.time()) - 60
TOKEN = jwt.encode({"iss": ISSUER, "iat": now, "exp": now + 1100, "aud": "appstoreconnect-v1"}, P8, algorithm="ES256", headers={"kid": KEY_ID, "typ": "JWT"})
def call(m, path, body=None):
    for a in range(6):
        r = requests.request(m, B + path, headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}, data=json.dumps(body) if body else None)
        if r.status_code != 401: break
        time.sleep(4 * (a + 1))
    print(" ", m, path.split("?")[0], r.status_code, "" if r.status_code < 400 else r.text[:800])
    return r
aid = call("GET", "/v1/apps?filter[bundleId]=app.startier").json()["data"][0]["id"]
v = call("GET", f"/v1/apps/{aid}/appStoreVersions?limit=1").json()["data"][0]
locs = call("GET", f"/v1/appStoreVersions/{v['id']}/appStoreVersionLocalizations").json()["data"]
SETS=[s.split(':') for s in (os.environ.get('SHOT_SETS') or 'store/screenshots:APP_IPHONE_67,store/screenshots-ipad:APP_IPAD_PRO_3GEN_129').split(',')]
for loc in locs:
  for DIR, DT in SETS:
      print("== locale", loc["attributes"]["locale"])
      sets = call("GET", f"/v1/appStoreVersionLocalizations/{loc['id']}/appScreenshotSets").json()["data"]
      st = next((s for s in sets if s["attributes"]["screenshotDisplayType"] == DT), None)
      if st:
          for old in call("GET", f"/v1/appScreenshotSets/{st['id']}/appScreenshots").json()["data"]:
              call("DELETE", f"/v1/appScreenshots/{old['id']}")
      else:
          st = call("POST", "/v1/appScreenshotSets", {"data": {"type": "appScreenshotSets", "attributes": {"screenshotDisplayType": DT},
                "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": loc["id"]}}}}}).json()["data"]
      for f in sorted(glob.glob(DIR+"/*.png")):
          data = open(f, "rb").read()
          sc = call("POST", "/v1/appScreenshots", {"data": {"type": "appScreenshots", "attributes": {"fileName": os.path.basename(f), "fileSize": len(data)},
                "relationships": {"appScreenshotSet": {"data": {"type": "appScreenshotSets", "id": st["id"]}}}}}).json()["data"]
          for op in sc["attributes"]["uploadOperations"]:
              requests.request(op["method"], op["url"], headers={h["name"]: h["value"] for h in op.get("requestHeaders", [])}, data=data[op["offset"]: op["offset"] + op["length"]])
          call("PATCH", f"/v1/appScreenshots/{sc['id']}", {"data": {"type": "appScreenshots", "id": sc["id"], "attributes": {"uploaded": True, "sourceFileChecksum": hashlib.md5(data).hexdigest()}}})
      time.sleep(15)
      for s in call("GET", f"/v1/appScreenshotSets/{st['id']}/appScreenshots").json()["data"]:
          print("  ", s["attributes"]["fileName"], (s["attributes"].get("assetDeliveryState") or {}).get("state"))
