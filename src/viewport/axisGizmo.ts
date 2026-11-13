import { Quaternion, Vector3, type PerspectiveCamera } from 'three';

const NS = 'http://www.w3.org/2000/svg';

/** Corner axis gizmo (SVG, updated from the camera orientation). Z-up: x red, y green, z blue. */
export class AxisGizmo {
  readonly el: SVGSVGElement;
  private readonly parts: { axis: Vector3; line: SVGLineElement; label: SVGTextElement; cls: string }[] = [];
  private readonly q = new Quaternion();
  private readonly v = new Vector3();

  constructor(private readonly size = 56) {
    this.el = document.createElementNS(NS, 'svg');
    this.el.setAttribute('width', String(size));
    this.el.setAttribute('height', String(size));
    this.el.setAttribute('viewBox', `0 0 ${size} ${size}`);
    this.el.classList.add('kt-axis-gizmo');
    const axes: [Vector3, string, string][] = [
      [new Vector3(1, 0, 0), 'x', 'kt-axis-x'],
      [new Vector3(0, 1, 0), 'y', 'kt-axis-y'],
      [new Vector3(0, 0, 1), 'z', 'kt-axis-z'],
    ];
    for (const [axis, name, cls] of axes) {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('class', `kt-axis-line ${cls}`);
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('class', `kt-axis-label ${cls}`);
      label.textContent = name;
      this.el.append(line, label);
      this.parts.push({ axis, line, label, cls });
    }
  }

  update(camera: PerspectiveCamera): void {
    this.q.copy(camera.quaternion).invert();
    const c = this.size / 2;
    const len = this.size * 0.36;
    for (const p of this.parts) {
      this.v.copy(p.axis).applyQuaternion(this.q);
      const x = c + this.v.x * len;
      const y = c - this.v.y * len;
      p.line.setAttribute('x1', String(c));
      p.line.setAttribute('y1', String(c));
      p.line.setAttribute('x2', x.toFixed(1));
      p.line.setAttribute('y2', y.toFixed(1));
      p.label.setAttribute('x', (c + this.v.x * (len + 7) - 3).toFixed(1));
      p.label.setAttribute('y', (c - this.v.y * (len + 7) + 3).toFixed(1));
      p.label.style.opacity = this.v.z < -0.2 ? '0.45' : '1';
    }
  }
}
