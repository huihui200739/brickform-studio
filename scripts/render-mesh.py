"""Inspect an exported triangle mesh without the browser or website UI."""
import json,sys,numpy as np
from PIL import Image
mesh=json.load(open(sys.argv[1])); vertices=np.array(mesh['positions']).reshape(-1,3,3)
colors=np.array(mesh['colors']).reshape(-1,3)
views=[np.array([1.4,.8,1.5]),np.array([0.,.1,1.]),np.array([1.,.1,0.])]
W,H=900,800; images=[]
for camera in views:
 camera/=np.linalg.norm(camera); right=np.cross([0,1,0],camera);right/=np.linalg.norm(right);up=np.cross(camera,right)
 light=np.array([-.3,1.,1.]);light/=np.linalg.norm(light)
 p=np.stack([vertices@right,-vertices@up,vertices@camera],axis=-1)
 mi=p[:,:,:2].reshape(-1,2).min(axis=0);ma=p[:,:,:2].reshape(-1,2).max(axis=0)
 scale=min((W-90)/(ma[0]-mi[0]),(H-90)/(ma[1]-mi[1]));offset=np.array([W/2,H/2])-(ma+mi)/2*scale
 pixels=np.full((H,W,3),[237,240,244],dtype=np.uint8);depth=np.full((H,W),-np.inf)
 for pts,v,col in zip(p,vertices,colors):
  n=np.cross(v[1]-v[0],v[2]-v[0]);norm=np.linalg.norm(n)
  if norm<1e-10:continue
  n/=norm
  if n@camera<-.02:continue
  color=col*(.55+.45*max(0,n@light))
  xy=pts[:,:2]*scale+offset
  lo=np.maximum(np.floor(xy.min(axis=0)).astype(int),0);hi=np.minimum(np.ceil(xy.max(axis=0)).astype(int),[W-1,H-1])
  x,y=np.meshgrid(np.arange(lo[0],hi[0]+1)+.5,np.arange(lo[1],hi[1]+1)+.5)
  a,b,c=xy;den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
  if abs(den)<1e-8:continue
  wa=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/den
  wb=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/den
  wc=1-wa-wb;z=wa*pts[0,2]+wb*pts[1,2]+wc*pts[2,2]
  sub=depth[lo[1]:hi[1]+1,lo[0]:hi[0]+1];mask=(wa>=-1e-5)&(wb>=-1e-5)&(wc>=-1e-5)&(z>sub)
  sub[mask]=z[mask];pixels[lo[1]:hi[1]+1,lo[0]:hi[0]+1][mask]=np.clip(color,0,255).astype(np.uint8)
 images.append(Image.fromarray(pixels))
canvas=Image.new('RGB',(W*len(images),H),'white')
for i,img in enumerate(images):canvas.paste(img,(W*i,0))
canvas.save(sys.argv[2])
