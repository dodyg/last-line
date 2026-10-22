import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { simulationToWorld } from '../src/render/app/coordinates';
import { tracerWorldEndpoints, weaponMuzzleWorldPosition } from '../src/render/app/tracer';

describe('rifle tracer rendering', () => {
  it.each([
    { name: 'friendly soldier firing north-west', from: { x: 420, y: 590 }, to: { x: 180, y: 210 } },
    { name: 'enemy soldier firing south-east', from: { x: 180, y: 210 }, to: { x: 420, y: 590 } },
  ])('starts at the $name muzzle and ends on the target body', ({ from, to }) => {
    const [worldX, , worldZ] = simulationToWorld(from.x, from.y);
    const root = new THREE.Group();
    root.position.set(worldX, 0, worldZ);
    const facing = Math.atan2(to.y - from.y, to.x - from.x);
    root.rotation.y = -facing - Math.PI / 2;
    const weaponLength = .26;
    const weapon = new THREE.Mesh(new THREE.BoxGeometry(.045, .045, weaponLength), new THREE.MeshBasicMaterial());
    weapon.position.set(.02, .4, -.25);
    root.add(weapon);
    root.updateWorldMatrix(true, true);

    const muzzle = weaponMuzzleWorldPosition(weapon, weaponLength);
    const [targetX, targetY, targetZ] = simulationToWorld(to.x, to.y, .4);
    const target = new THREE.Vector3(targetX, targetY, targetZ);
    const aimX = target.x - root.position.x;
    const aimZ = target.z - root.position.z;
    const muzzleX = muzzle.x - root.position.x;
    const muzzleZ = muzzle.z - root.position.z;

    // The modeled barrel tip must lie on the shooter's aim ray for either team.
    expect(muzzleX * aimX + muzzleZ * aimZ).toBeGreaterThan(0);
    expect(Math.abs(muzzleX * aimZ - muzzleZ * aimX) / Math.hypot(aimX, aimZ)).toBeCloseTo(.02, 6);
    expect(muzzle.y).toBeCloseTo(.4, 6);

    const [start, end] = tracerWorldEndpoints(muzzle, target);
    expect(start).toEqual(muzzle);
    expect(end).toEqual(target);
    muzzle.x = 100;
    expect(start.x).not.toBe(100);
  });
});
