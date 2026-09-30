import importlib.util
from pathlib import Path
import tempfile, unittest
import numpy as np
import trimesh
spec=importlib.util.spec_from_file_location('fusion',Path(__file__).with_name('multiview-fusion.py'))
fusion=importlib.util.module_from_spec(spec); spec.loader.exec_module(fusion)

def cube_scene():
    n=64; k=np.array([[55.,0,n/2],[0,55.,n/2],[0,0,1.]])
    cameras=[]; depths=[]; points=[]; images=[]; masks=[]
    for origin in [np.array([0.,1.1,4]),np.array([4.,1.1,0]),np.array([0.,4.,.5])]:
        forward=-origin/np.linalg.norm(origin)
        right=np.cross(forward,[0,1,0]);right/=np.linalg.norm(right)
        down=np.cross(forward,right);basis=np.stack([right,down,forward],axis=1)
        pose=np.eye(4);pose[:3,:3]=basis;pose[:3,3]=origin;cameras.append(pose)
        y,x=np.indices((n,n)); rays=np.stack([(x-n/2)/55,(y-n/2)/55,np.ones_like(x)],axis=-1)@basis.T
        safe=np.where(np.abs(rays)<1e-9,1e-9,rays)
        a=(-1-origin)/safe;b=(1-origin)/safe
        near=np.minimum(a,b).max(-1);far=np.maximum(a,b).min(-1);valid=(far>near)&(near>0)
        depth=np.where(valid,near,0);point=origin+rays*depth[...,None]
        image=np.full((n,n,3),255,np.uint8);image[valid]=[195,163,117]
        depths.append(depth);points.append(point);images.append(image);masks.append(valid)
    cameras=np.array(cameras)
    return dict(images=np.array(images),world_points=np.array(points),depth=np.array(depths),masks=np.array(masks),
                confidence=np.ones((3,n,n)),camera_poses=cameras,extrinsics=np.linalg.inv(cameras),intrinsics=np.tile(k,(3,1,1)))

class FusionTests(unittest.TestCase):
    def test_shared_world_cube_is_closed_and_keeps_colour(self):
        with tempfile.TemporaryDirectory() as d:
            output=Path(d)/'cube.glb';report=fusion.fuse_scene(cube_scene(),output,64)
            mesh=trimesh.load(output,force='mesh')
            self.assertTrue(report['watertight']);self.assertEqual(report['jointViews'],3)
            self.assertTrue(report['conversionAllowed'])
            self.assertLess(max(mesh.extents)/min(mesh.extents),1.2)
            linear=mesh.visual.vertex_colors[:,:3]/255
            srgb=np.where(linear<=.0031308,linear*12.92,1.055*linear**(1/2.4)-.055)*255
            self.assertTrue(np.all(np.abs(srgb-[195,163,117])<2))
    def test_mislabeled_side_camera_cannot_be_converted(self):
        with tempfile.TemporaryDirectory() as d:
            scene=cube_scene();scene['camera_poses'][1,:3,:3]=scene['camera_poses'][0,:3,:3]
            report=fusion.fuse_scene(scene,Path(d)/'bad.glb',48)
            self.assertFalse(report['conversionAllowed'])
            self.assertIn('侧面',report['failures'][0])
    def test_top_depth_actually_changes_joint_geometry(self):
        with tempfile.TemporaryDirectory() as d:
            scene=cube_scene();output=Path(d)/'one.glb';fusion.fuse_scene(scene,output,48)
            before=trimesh.load(output,force='mesh')
            pose=scene['camera_poses'][2];depth=scene['depth'][2]
            valid=scene['masks'][2];depth[valid]*=.85
            local=(scene['world_points'][2]-pose[:3,3])@pose[:3,:3]
            local[valid]*=.85
            scene['world_points'][2]=local@pose[:3,:3].T+pose[:3,3]
            fusion.fuse_scene(scene,Path(d)/'two.glb',48)
            after=trimesh.load(Path(d)/'two.glb',force='mesh')
            self.assertGreater(abs(after.volume-before.volume),.1)

    def test_depth_conflict_blocks_conversion_even_with_good_camera_angles(self):
        with tempfile.TemporaryDirectory() as d:
            scene=cube_scene(); pose=scene['camera_poses'][2]
            valid=scene['masks'][2]
            scene['depth'][2][valid] *= .85
            local=(scene['world_points'][2]-pose[:3,3])@pose[:3,:3]
            local[valid] *= .85
            scene['world_points'][2]=local@pose[:3,:3].T+pose[:3,3]
            report=fusion.fuse_scene(scene,Path(d)/'conflict.glb',64)
            self.assertGreater(report['cameraAngles']['frontSide'],20)
            self.assertGreater(report['cameraAngles']['frontTop'],20)
            self.assertFalse(report['conversionAllowed'])
            self.assertTrue(any('深度' in reason for reason in report['failures']))

if __name__=='__main__':unittest.main()
