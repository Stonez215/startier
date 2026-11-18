import os, time, json, jwt, requests
K,I,P=os.environ["ASC_KEY_ID"],os.environ["ASC_ISSUER_ID"],os.environ["ASC_KEY_P8"]
n=int(time.time())-60; T=jwt.encode({"iss":I,"iat":n,"exp":n+1100,"aud":"appstoreconnect-v1"},P,algorithm="ES256",headers={"kid":K,"typ":"JWT"})
def c(m,p,b=None):
    for a in range(6):
        r=requests.request(m,"https://api.appstoreconnect.apple.com"+p,headers={"Authorization":"Bearer "+T,"Content-Type":"application/json"},data=json.dumps(b) if b else None)
        if r.status_code!=401: break
        time.sleep(4)
    print(m,p,r.status_code,r.text[:1200]); return r
s="bb4e79ef-baa0-49b0-99a0-8f502bb7c854"; it="YmI0ZTc5ZWYtYmFhMC00OWIwLTk5YTAtOGY1MDJiYjdjODU0fDZ8ODk0OTMxNTU0"
c("PATCH",f"/v1/reviewSubmissionItems/{it}",{"data":{"type":"reviewSubmissionItems","id":it,"attributes":{"resolved":True}}})
c("PATCH",f"/v1/reviewSubmissions/{s}",{"data":{"type":"reviewSubmissions","id":s,"attributes":{"submitted":True}}})
