"""Collision mesh for a generated world: the visual mesh decimated to 200k faces, no colours or textures."""
import sys, trimesh
src, dst, faces = sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 200000
m = trimesh.load(src).to_geometry()
c = m.simplify_quadric_decimation(face_count=min(faces, len(m.faces))); c.visual = trimesh.visual.ColorVisuals()
c.export(dst)
print(f"collision: {len(m.faces)} -> {len(c.faces)} faces, bounds {m.bounds.round(3).tolist()}")
