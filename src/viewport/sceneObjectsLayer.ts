import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, type BufferGeometry, type Scene } from 'three';
import type { SceneObjectDef } from './viewState';

/**
 * Reference objects (boxes / cylinders / spheres) placed next to the plant. They live directly in the scene (never in
 * the plant content), so view modes, outlines and picking of the plant ignore them. Z-up: z = half the height.
 */
export class SceneObjectsLayer {
  private readonly group = new Group();
  private readonly material = new MeshStandardMaterial({ color: 0x8f9aa8, roughness: 0.85, metalness: 0 });
  private readonly geometries: BufferGeometry[] = [];

  constructor(private readonly scene: Scene) {
    this.group.name = 'SceneObjects';
    scene.add(this.group);
  }

  set(objects: readonly SceneObjectDef[]): void {
    for (const c of [...this.group.children]) this.group.remove(c);
    this.geometries.forEach((g) => g.dispose());
    this.geometries.length = 0;
    for (const o of objects) {
      let geo: BufferGeometry;
      if (o.kind === 'box') geo = new BoxGeometry(o.sx, o.sy, o.sz);
      else if (o.kind === 'cylinder') {
        geo = new CylinderGeometry(o.sx / 2, o.sx / 2, o.sz, 32);
        geo.rotateX(Math.PI / 2); // three cylinders are Y-up: stand them up on +Z
      } else geo = new SphereGeometry(o.sx / 2, 32, 16);
      this.geometries.push(geo);
      const mesh = new Mesh(geo, this.material);
      mesh.position.set(o.x, o.y, o.kind === 'sphere' ? o.sx / 2 : o.sz / 2);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.sceneObject = o.id;
      this.group.add(mesh);
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.geometries.forEach((g) => g.dispose());
    this.material.dispose();
  }
}
