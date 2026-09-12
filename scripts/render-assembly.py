"""Offline geometry inspection, independent of the website or its browser UI."""
import json, sys, numpy as np
from PIL import Image, ImageDraw
model=json.load(open(sys.argv[1]))
parts=json.load(open('public/parts/geometry.json'))
palette=['#F4F4F4','#242424','#C91A09','#F2CD37','#0055BF','#237841','#FE8A18','#D7BA8C','#897D62','#5F3109','#352100','#969696','#646464','#708E7C']
view=sys.argv[3] if len(sys.argv)>3 else 'hero'
camera=np.array({'hero':[-1.3,.8,1.5],'front':[.0001,.05,1],'side':[-1,.04,0],'back':[.0001,.08,-1]}.get(view,[-1.3,.8,1.5])); camera=camera/np.linalg.norm(camera)
right=np.cross([0,1,0],camera);right/=np.linalg.norm(right)
up=np.cross(camera,right)
light=np.array([-.4,1,.6]);light/=np.linalg.norm(light)
triangles=[]
lines=[]
edge_cache={}
for part,g in parts.items():
    ps=np.array(g['positions']).reshape(-1,3,3);ns=np.array(g['normals']).reshape(-1,3,3).mean(axis=1)
    edges={}
    for tri,n in zip(ps,ns):
        for ia,ib in [(0,1),(1,2),(2,0)]:
            a,b=tuple(np.round(tri[ia],3)),tuple(np.round(tri[ib],3));k=tuple(sorted([a,b]))
            if k not in edges:edges[k]=[n,False]
            elif np.dot(edges[k][0],n)<.8:edges[k][1]=True
    edge_cache[part]=np.array([k for k,v in edges.items() if v[1]])

for b in model['bricks']:
    geom=parts[b['part']]
    vertices=np.array(geom['positions']).reshape(-1,3)
    normals=np.array(geom['normals']).reshape(-1,3)
    matrix=np.array(b['pose']['matrix']).reshape(3,3)
    vertices=(vertices@matrix.T+np.array(b['pose']['position']))*np.array([1,-1,1])
    normals=(normals@matrix.T)*np.array([1,-1,1])
    projected=np.column_stack([vertices@right,-vertices@up,vertices@camera]).reshape(-1,3,3)
    ns=normals.reshape(-1,3,3).mean(axis=1)
    if len(edge_cache[b['part']]):
        es=edge_cache[b['part']].reshape(-1,3)
        es=(es@matrix.T+np.array(b['pose']['position']))*np.array([1,-1,1])
        lines.extend(np.column_stack([es@right,-es@up,es@camera]).reshape(-1,2,3))
    color=np.array([int(palette[b['color']][i:i+2],16) for i in [1,3,5]])
    for points,n in zip(projected,ns):
        if n@camera<-.05:continue
        brightness=.68+.32*max(0,n@light)
        triangles.append((points,tuple(np.clip(color*brightness,0,255).astype(int))))
allpoints=np.vstack([t[0] for t in triangles]);mi=allpoints[:,:2].min(axis=0);ma=allpoints[:,:2].max(axis=0)
W,H=1600,1500;scale=min((W-160)/(ma[0]-mi[0]),(H-160)/(ma[1]-mi[1]));offset=np.array([W/2,H/2])-(ma+mi)/2*scale
pixels=np.full((H,W,3),[237,240,244],dtype=np.uint8);depth=np.full((H,W),-np.inf)
for pts,col in triangles:
    p=pts[:,:2]*scale+offset
    lo=np.maximum(np.floor(p.min(axis=0)).astype(int),0);hi=np.minimum(np.ceil(p.max(axis=0)).astype(int),[W-1,H-1])
    x,y=np.meshgrid(np.arange(lo[0],hi[0]+1)+.5,np.arange(lo[1],hi[1]+1)+.5)
    a,b,c=p;den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
    if abs(den)<1e-8:continue
    wa=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/den
    wb=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/den
    wc=1-wa-wb;z=wa*pts[0,2]+wb*pts[1,2]+wc*pts[2,2]
    sub=depth[lo[1]:hi[1]+1,lo[0]:hi[0]+1];mask=(wa>=-1e-5)&(wb>=-1e-5)&(wc>=-1e-5)&(z>sub)
    sub[mask]=z[mask];pixels[lo[1]:hi[1]+1,lo[0]:hi[0]+1][mask]=col
for line in lines:
    p=line[:,:2]*scale+offset
    steps=max(2,int(np.max(np.abs(p[1]-p[0])))+1)
    t=np.linspace(0,1,steps);xy=np.round(p[0]+t[:,None]*(p[1]-p[0])).astype(int)
    z=line[0,2]+t*(line[1,2]-line[0,2])
    valid=(xy[:,0]>=0)&(xy[:,0]<W)&(xy[:,1]>=0)&(xy[:,1]<H)
    xy=xy[valid];z=z[valid]
    visible=z>=depth[xy[:,1],xy[:,0]]-.15
    xy=xy[visible]
    pixels[xy[:,1],xy[:,0]]=(pixels[xy[:,1],xy[:,0]]*.82).astype(np.uint8)
Image.fromarray(pixels).resize((W//2,H//2),Image.Resampling.LANCZOS).save(sys.argv[2])
