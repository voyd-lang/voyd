import fs from "node:fs";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";

type ScatterTarget = {
  attenuation: Vec3;
  scattered: Ray;
};

interface RandomSource {
  next(): number;
  nextRange(min: number, max: number): number;
}

interface Hittable {
  hit(ray: Ray, rayT: Interval, rec: HitRecord): boolean;
}

interface Material {
  scatter(rIn: Ray, rec: HitRecord, target: ScatterTarget, rng: RandomSource): boolean;
}

class MathRandom implements RandomSource {
  next(): number {
    return Math.random();
  }

  nextRange(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}

class Mulberry32Random implements RandomSource {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextRange(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}

class Vec3 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}

  static empty(): Vec3 {
    return new Vec3(0, 0, 0);
  }

  static random(rng: RandomSource, min = 0, max = 1): Vec3 {
    return new Vec3(
      rng.nextRange(min, max),
      rng.nextRange(min, max),
      rng.nextRange(min, max),
    );
  }

  static randomUnitVector(rng: RandomSource): Vec3 {
    for (;;) {
      const p = Vec3.random(rng, -1, 1);
      const lensq = p.lenSquared();
      if (1e-160 < lensq && lensq <= 1) {
        return p.divScalar(Math.sqrt(lensq));
      }
    }
  }

  static randomInUnitDisk(rng: RandomSource): Vec3 {
    for (;;) {
      const p = new Vec3(rng.nextRange(-1, 1), rng.nextRange(-1, 1), 0);
      if (p.lenSquared() < 1) {
        return p;
      }
    }
  }

  set(other: Vec3): void {
    this.x = other.x;
    this.y = other.y;
    this.z = other.z;
  }

  add(other: Vec3): Vec3 {
    return new Vec3(this.x + other.x, this.y + other.y, this.z + other.z);
  }

  addInPlace(other: Vec3): void {
    this.x += other.x;
    this.y += other.y;
    this.z += other.z;
  }

  sub(other: Vec3): Vec3 {
    return new Vec3(this.x - other.x, this.y - other.y, this.z - other.z);
  }

  neg(): Vec3 {
    return new Vec3(-this.x, -this.y, -this.z);
  }

  mulVec(other: Vec3): Vec3 {
    return new Vec3(this.x * other.x, this.y * other.y, this.z * other.z);
  }

  mulScalar(scalar: number): Vec3 {
    return new Vec3(this.x * scalar, this.y * scalar, this.z * scalar);
  }

  divScalar(scalar: number): Vec3 {
    return new Vec3(this.x / scalar, this.y / scalar, this.z / scalar);
  }

  cross(other: Vec3): Vec3 {
    return new Vec3(
      this.y * other.z - this.z * other.y,
      this.z * other.x - this.x * other.z,
      this.x * other.y - this.y * other.x,
    );
  }

  dot(other: Vec3): number {
    return this.x * other.x + this.y * other.y + this.z * other.z;
  }

  len(): number {
    return Math.sqrt(this.lenSquared());
  }

  lenSquared(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  nearZero(): boolean {
    return Math.abs(this.x) < 1e-8 && Math.abs(this.y) < 1e-8 && Math.abs(this.z) < 1e-8;
  }

  unitVector(): Vec3 {
    return this.divScalar(this.len());
  }

  reflect(normal: Vec3): Vec3 {
    return this.sub(normal.mulScalar(2 * this.dot(normal)));
  }

  refract(normal: Vec3, etaiOverEtat: number): Vec3 {
    const cosTheta = Math.min(this.neg().dot(normal), 1);
    const rOutPerp = this.add(normal.mulScalar(cosTheta)).mulScalar(etaiOverEtat);
    const rOutParallel = normal.mulScalar(-Math.sqrt(Math.abs(1 - rOutPerp.lenSquared())));
    return rOutPerp.add(rOutParallel);
  }
}

type Point3 = Vec3;
type Color = Vec3;

class Ray {
  constructor(
    public origin: Vec3,
    public direction: Vec3,
  ) {}

  static empty(): Ray {
    return new Ray(Vec3.empty(), Vec3.empty());
  }

  at(t: number): Vec3 {
    return this.origin.add(this.direction.mulScalar(t));
  }

  set(other: Ray): void {
    this.origin = other.origin;
    this.direction = other.direction;
  }
}

class Interval {
  constructor(
    public min: number,
    public max: number,
  ) {}

  clamp(x: number): number {
    if (x < this.min) {
      return this.min;
    }
    if (x > this.max) {
      return this.max;
    }
    return x;
  }

  surrounds(x: number): boolean {
    return this.min < x && x < this.max;
  }
}

class Lambertian implements Material {
  constructor(public albedo: Color) {}

  scatter(_rIn: Ray, rec: HitRecord, target: ScatterTarget, rng: RandomSource): boolean {
    let scatterDirection = rec.normal.add(Vec3.randomUnitVector(rng));
    if (scatterDirection.nearZero()) {
      scatterDirection = rec.normal;
    }

    target.scattered.set(new Ray(rec.p, scatterDirection));
    target.attenuation.set(this.albedo);
    return true;
  }
}

class Metal implements Material {
  constructor(
    public albedo: Color,
    public fuzz: number,
  ) {}

  scatter(rIn: Ray, rec: HitRecord, target: ScatterTarget, rng: RandomSource): boolean {
    let reflected = rIn.direction.reflect(rec.normal);
    reflected = reflected.unitVector().add(Vec3.randomUnitVector(rng).mulScalar(this.fuzz));
    target.scattered.set(new Ray(rec.p, reflected));
    target.attenuation.set(this.albedo);
    return true;
  }
}

class Dielectric implements Material {
  constructor(public refractionIndex: number) {}

  scatter(rIn: Ray, rec: HitRecord, target: ScatterTarget, rng: RandomSource): boolean {
    target.attenuation.set(new Vec3(1, 1, 1));
    const ri = rec.frontFace ? 1 / this.refractionIndex : this.refractionIndex;
    const unitDirection = rIn.direction.unitVector();
    const cosTheta = Math.min(unitDirection.neg().dot(rec.normal), 1);
    const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
    const cannotRefract = ri * sinTheta > 1;
    const direction =
      cannotRefract || this.reflectance(cosTheta) > rng.next()
        ? unitDirection.reflect(rec.normal)
        : unitDirection.refract(rec.normal, ri);
    target.scattered.set(new Ray(rec.p, direction));
    return true;
  }

  private reflectance(cosine: number): number {
    let r0 = (1 - this.refractionIndex) / (1 + this.refractionIndex);
    r0 *= r0;
    return r0 + (1 - r0) * Math.pow(1 - cosine, 5);
  }
}

class HitRecord {
  p = new Vec3(0, 0, 0);
  normal = new Vec3(0, 0, 0);
  mat: Material = new Lambertian(new Vec3(0, 0, 0));
  t = 0;
  frontFace = false;

  set(other: HitRecord): void {
    this.p = other.p;
    this.normal = other.normal;
    this.mat = other.mat;
    this.t = other.t;
    this.frontFace = other.frontFace;
  }

  setFaceNormal(ray: Ray, outwardNormal: Vec3): void {
    this.frontFace = ray.direction.dot(outwardNormal) < 0;
    this.normal = this.frontFace ? outwardNormal : outwardNormal.mulScalar(-1);
  }
}

class Sphere implements Hittable {
  constructor(
    public center: Point3,
    public radius: number,
    public mat: Material,
  ) {}

  hit(ray: Ray, rayT: Interval, rec: HitRecord): boolean {
    const oc = this.center.sub(ray.origin);
    const a = ray.direction.lenSquared();
    const h = ray.direction.dot(oc);
    const c = oc.lenSquared() - this.radius * this.radius;
    const discriminant = h * h - a * c;
    if (discriminant < 0) {
      return false;
    }

    const sqrtd = Math.sqrt(discriminant);
    let root = (h - sqrtd) / a;
    if (!rayT.surrounds(root)) {
      root = (h + sqrtd) / a;
      if (!rayT.surrounds(root)) {
        return false;
      }
    }

    rec.t = root;
    rec.p = ray.at(rec.t);
    rec.mat = this.mat;
    const outwardNormal = rec.p.sub(this.center).divScalar(this.radius);
    rec.setFaceNormal(ray, outwardNormal);
    return true;
  }
}

class HittableList implements Hittable {
  readonly objects: Hittable[] = [];

  add(object: Hittable): void {
    this.objects.push(object);
  }

  hit(ray: Ray, rayT: Interval, rec: HitRecord): boolean {
    const tempRec = new HitRecord();
    let hitAnything = false;
    let closestSoFar = rayT.max;

    for (const object of this.objects) {
      if (object.hit(ray, new Interval(rayT.min, closestSoFar), tempRec)) {
        hitAnything = true;
        closestSoFar = tempRec.t;
        rec.set(tempRec);
      }
    }

    return hitAnything;
  }
}

type CameraOptions = {
  aspectRatio: number;
  imageWidth: number;
  samplesPerPixel: number;
  maxDepth: number;
  lookFrom: Point3;
  lookAt: Point3;
  vup: Vec3;
  vfov: number;
  defocusAngle: number;
  focusDist: number;
};

class Camera {
  readonly imageHeight: number;
  readonly center: Point3;
  readonly pixelSamplesScale: number;
  readonly pixel00Loc: Point3;
  readonly pixelDeltaU: Vec3;
  readonly pixelDeltaV: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly w: Vec3;
  readonly defocusDiskU: Vec3;
  readonly defocusDiskV: Vec3;

  constructor(readonly options: CameraOptions) {
    this.imageHeight = Math.max(1, Math.trunc(options.imageWidth / options.aspectRatio));
    this.center = options.lookFrom;

    const theta = degreesToRadians(options.vfov);
    const h = Math.tan(theta / 2);
    const viewportHeight = 2 * h * options.focusDist;
    const viewportWidth = viewportHeight * (options.imageWidth / this.imageHeight);

    this.w = options.lookFrom.sub(options.lookAt).unitVector();
    this.u = options.vup.cross(this.w);
    this.v = this.w.cross(this.u);

    const viewportU = this.u.mulScalar(viewportWidth);
    const viewportV = this.v.mulScalar(-viewportHeight);

    this.pixelDeltaU = viewportU.divScalar(options.imageWidth);
    this.pixelDeltaV = viewportV.divScalar(this.imageHeight);

    const viewportUpperLeft = this.center
      .sub(this.w.mulScalar(options.focusDist))
      .sub(viewportU.divScalar(2))
      .sub(viewportV.divScalar(2));

    this.pixel00Loc = viewportUpperLeft.add(this.pixelDeltaU.add(this.pixelDeltaV).mulScalar(0.5));
    this.pixelSamplesScale = 1 / options.samplesPerPixel;

    const defocusRadius = options.focusDist * Math.tan(degreesToRadians(options.defocusAngle / 2));
    this.defocusDiskU = this.u.mulScalar(defocusRadius);
    this.defocusDiskV = this.v.mulScalar(defocusRadius);
  }

  async render(world: Hittable, rng: RandomSource, outputPath?: string): Promise<void> {
    const stream = outputPath ? fs.createWriteStream(outputPath) : process.stdout;
    stream.write(`P3\n${this.options.imageWidth} ${this.imageHeight}\n255\n`);

    for (let j = 0; j < this.imageHeight; j += 1) {
      process.stderr.write(`\rScanlines remaining: ${this.imageHeight - j}`);
      let scanline = "";
      for (let i = 0; i < this.options.imageWidth; i += 1) {
        const color = new Vec3(1, 1, 1);
        for (let sample = 0; sample < this.options.samplesPerPixel; sample += 1) {
          const ray = this.getRay(i, j, rng);
          color.addInPlace(rayColor(ray, this.options.maxDepth, world, rng));
        }
        scanline += colorToLine(color.mulScalar(this.pixelSamplesScale));
      }
      stream.write(scanline);
    }

    process.stderr.write("\n");
    if (outputPath) {
      (stream as fs.WriteStream).end();
      await finished(stream as fs.WriteStream);
    }
  }

  private getRay(i: number, j: number, rng: RandomSource): Ray {
    const offset = sampleSquare(rng);
    const pixelSample = this.pixel00Loc
      .add(this.pixelDeltaU.mulScalar(i + offset.x))
      .add(this.pixelDeltaV.mulScalar(j + offset.y));
    const rayOrigin =
      this.options.defocusAngle <= 0 ? this.center : this.defocusDiskSample(rng);
    const rayDirection = pixelSample.sub(rayOrigin);
    return new Ray(rayOrigin, rayDirection);
  }

  private defocusDiskSample(rng: RandomSource): Point3 {
    const p = Vec3.randomInUnitDisk(rng);
    return this.center
      .add(this.defocusDiskU.mulScalar(p.x))
      .add(this.defocusDiskV.mulScalar(p.y));
  }
}

const EMPTY = new Vec3(0, 0, 0);
const ONE = new Vec3(1, 1, 1);
const SKY = new Vec3(0.5, 0.7, 1);
const RAY_T = new Interval(0.001, Number.POSITIVE_INFINITY);
const INTENSITY = new Interval(0, 0.999);

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function sampleSquare(rng: RandomSource): Vec3 {
  return new Vec3(rng.next() - 0.5, rng.next() - 0.5, 0);
}

function rayColor(ray: Ray, depth: number, world: Hittable, rng: RandomSource): Color {
  if (depth <= 0) {
    return EMPTY;
  }

  const rec = new HitRecord();
  if (world.hit(ray, RAY_T, rec)) {
    const target: ScatterTarget = {
      attenuation: Vec3.empty(),
      scattered: Ray.empty(),
    };
    if (rec.mat.scatter(ray, rec, target, rng)) {
      return target.attenuation.mulVec(rayColor(target.scattered, depth - 1, world, rng));
    }
    return new Vec3(0, 0, 0);
  }

  const unitDirection = ray.direction.unitVector();
  const a = 0.5 * (unitDirection.y + 1);
  return ONE.mulScalar(1 - a).add(SKY.mulScalar(a));
}

function linearToGamma(linearComponent: number): number {
  return linearComponent > 0 ? Math.sqrt(linearComponent) : 0;
}

function toPixel(color: number): number {
  return Math.trunc(256 * INTENSITY.clamp(linearToGamma(color)));
}

function colorToLine(color: Color): string {
  return `${toPixel(color.x)} ${toPixel(color.y)} ${toPixel(color.z)}\n`;
}

type RenderOptions = {
  imageWidth?: number;
  samplesPerPixel?: number;
  maxDepth?: number;
  outPath?: string;
  seed?: number;
};

async function renderVTrace(options: RenderOptions = {}): Promise<void> {
  const rng = options.seed === undefined ? new MathRandom() : new Mulberry32Random(options.seed);
  const world = new HittableList();
  const groundMaterial = new Lambertian(new Vec3(0.5, 0.5, 0.5));
  world.add(new Sphere(new Vec3(0, -1000, 0), 1000, groundMaterial));

  for (let a = -11; a < 11; a += 1) {
    for (let b = -11; b < 11; b += 1) {
      const chooseMat = rng.next();
      const center = new Vec3(a + 0.9 * rng.next(), 0.2, b + 0.9 * rng.next());

      if (center.sub(new Vec3(4, 0.2, 0)).len() > 0.9) {
        if (chooseMat < 0.8) {
          const albedo = Vec3.random(rng).mulVec(Vec3.random(rng));
          world.add(new Sphere(center, 0.2, new Lambertian(albedo)));
        } else if (chooseMat < 0.95) {
          const albedo = Vec3.random(rng, 0.5, 1);
          const fuzz = rng.nextRange(0, 0.5);
          world.add(new Sphere(center, 0.2, new Metal(albedo, fuzz)));
        } else {
          world.add(new Sphere(center, 0.2, new Dielectric(1.5)));
        }
      }
    }
  }

  world.add(new Sphere(new Vec3(0, 1, 0), 1, new Dielectric(1.5)));
  world.add(new Sphere(new Vec3(-4, 1, 0), 1, new Lambertian(new Vec3(0.4, 0.3, 0.2))));
  world.add(new Sphere(new Vec3(4, 1, 0), 1, new Metal(new Vec3(0.7, 0.6, 0.5), 0)));

  const camera = new Camera({
    aspectRatio: 16 / 9,
    imageWidth: options.imageWidth ?? 200,
    samplesPerPixel: options.samplesPerPixel ?? 10,
    maxDepth: options.maxDepth ?? 50,
    lookFrom: new Vec3(13, 2, 3),
    lookAt: new Vec3(0, 0, 0),
    vup: new Vec3(0, 1, 0),
    vfov: 20,
    defocusAngle: 0.6,
    focusDist: 10,
  });

  await camera.render(world, rng, options.outPath);
}

function parseArgs(argv: string[]): RenderOptions {
  const options: RenderOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--out" && next !== undefined) {
      options.outPath = next;
      i += 1;
    } else if (arg === "--seed" && next !== undefined) {
      options.seed = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--image-width" && next !== undefined) {
      options.imageWidth = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--samples-per-pixel" && next !== undefined) {
      options.samplesPerPixel = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--max-depth" && next !== undefined) {
      options.maxDepth = Number.parseInt(next, 10);
      i += 1;
    }
  }
  return options;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  renderVTrace(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

export { renderVTrace };
