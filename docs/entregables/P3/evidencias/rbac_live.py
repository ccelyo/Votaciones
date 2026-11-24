import json, os, ssl, urllib.request, urllib.error
GW="https://localhost:8088"; CTX=ssl.create_default_context(cafile=os.environ["CA"])
def call(m,p,b=None,t=None):
    r=urllib.request.Request(GW+p,method=m,data=json.dumps(b).encode() if b is not None else None,headers={"Content-Type":"application/json",**({"Authorization":"Bearer "+t} if t else {})})
    try:
        with urllib.request.urlopen(r,context=CTX,timeout=30) as x: return x.status, x.read()
    except urllib.error.HTTPError as e: return e.code, e.read()
def login(u):
    _,c=call("POST","/api/auth/login",{"username":u,"password":"prueba123"}); c=json.loads(c)
    _,t=call("POST","/api/auth/login/mfa",{"challenge_id":c["challenge_id"],"code":"123456"}); return json.loads(t)["access_token"]
v=login("votante1"); a=login("admin1")
checks=[("votante","GET","/api/auth/users",None,v,403),("votante","POST","/api/elections",{"name":"x","options":["a","b"]},v,403),
("votante","POST","/api/auth/users",{"username":"z","password":"zzzzzzzz"},v,403),("votante","POST","/api/tally/elections/1",None,v,403),
("votante","GET","/api/elections/open",None,v,200),("sin token","GET","/api/auth/users",None,None,401),("admin","GET","/api/auth/users",None,a,200)]
ok=0
for who,m,p,b,t,exp in checks:
    s,body=call(m,p,b,t); good=s==exp; ok+=good
    print(("✔" if good else "✘"),f"{who:9} {m:5} {p:28} -> {s} (esperado {exp})")
print(f"Resultado: {ok} correctos, {len(checks)-ok} fallidos.")
