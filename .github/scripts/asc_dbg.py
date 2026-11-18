import os, time, json, jwt, requests
K,I,P=os.environ["ASC_KEY_ID"],os.environ["ASC_ISSUER_ID"],os.environ["ASC_KEY_P8"]
n=int(time.time())-60; T=jwt.encode({"iss":I,"iat":n,"exp":n+1100,"aud":"appstoreconnect-v1"},P,algorithm="ES256",headers={"kid":K,"typ":"JWT"})
def g(p):
    for a in range(6):
        r=requests.get("https://api.appstoreconnect.apple.com"+p,headers={"Authorization":"Bearer "+T})
        if r.status_code!=401: return r
        time.sleep(4)
    return r
s="bb4e79ef-baa0-49b0-99a0-8f502bb7c854"
print(json.dumps(g(f"/v1/reviewSubmissions/{s}?include=items").json(),indent=1)[:2500])
print(json.dumps(g(f"/v1/reviewSubmissions/{s}/items").json(),indent=1)[:2500])
v=g("/v1/apps/6832798699/appStoreVersions?limit=1").json()["data"][0]
print(json.dumps(v["attributes"],indent=1))
