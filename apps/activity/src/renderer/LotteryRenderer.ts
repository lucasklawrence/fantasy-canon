import Matter, { Bodies, Body, Composite, Engine, Render, Runner, World } from "matter-js";

export interface LotteryRendererOptions {
  width?: number;
  height?: number;
}

export interface TeamBall {
  ballId: string;
  teamId: string;
}

export class LotteryRenderer {
  private engine: Engine;
  private runner: Runner;
  private render?: Render;
  private balls: Record<string, Body> = {};
  private width: number;
  private height: number;

  constructor(private canvas: HTMLCanvasElement, options?: LotteryRendererOptions) {
    this.engine = Engine.create({ gravity: { x: 0, y: 1 } });
    this.runner = Runner.create();
    this.width = options?.width ?? 640;
    this.height = options?.height ?? 360;

    this.setupWorld();
    this.setupRender();
  }

  private setupRender(): void {
    this.render = Render.create({
      canvas: this.canvas,
      engine: this.engine,
      options: {
        width: this.width,
        height: this.height,
        background: "transparent",
        wireframes: false
      }
    });
    Render.run(this.render);
    Runner.run(this.runner, this.engine);
  }

  private setupWorld(): void {
    const { world } = this.engine;
    World.clear(world, false);

    const thickness = 50;
    const floor = Bodies.rectangle(this.width / 2, this.height + thickness / 2 - 10, this.width, thickness, {
      isStatic: true
    });
    const left = Bodies.rectangle(-thickness / 2, this.height / 2, thickness, this.height, { isStatic: true });
    const right = Bodies.rectangle(this.width + thickness / 2, this.height / 2, thickness, this.height, { isStatic: true });
    const ceiling = Bodies.rectangle(this.width / 2, -thickness / 2 + 10, this.width, thickness, { isStatic: true });

    World.add(world, [floor, left, right, ceiling]);
  }

  reset(): void {
    this.clearBalls();
    this.setupWorld();
  }

  spawnBalls(balls: TeamBall[]): void {
    this.clearBalls();
    const { world } = this.engine;
    const radius = 14;
    balls.forEach((ball, idx) => {
      const body = Bodies.circle(this.width / 2 + (idx % 5) * 8 - 20, 40 + idx * 3, radius, {
        restitution: 0.9,
        friction: 0.02,
        render: {
          fillStyle: this.colorForTeam(ball.teamId)
        }
      });
      (body as any).ballId = ball.ballId;
      (body as any).teamId = ball.teamId;
      this.balls[ball.ballId] = body;
      World.add(world, body);
    });
  }

  async drawBall(ballId: string): Promise<void> {
    const body = this.balls[ballId];
    if (!body) return;
    const forceMagnitude = 0.02;
    Body.applyForce(body, body.position, { x: (Math.random() - 0.5) * forceMagnitude, y: -forceMagnitude });

    return new Promise((resolve) => {
      const check = () => {
        if (body.position.y < 40) {
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    });
  }

  destroy(): void {
    this.clearBalls();
    Render.stop(this.render);
    Runner.stop(this.runner);
    if (this.render?.canvas) {
      this.render.canvas.remove();
    }
  }

  private clearBalls(): void {
    const { world } = this.engine;
    Object.values(this.balls).forEach((b) => Composite.remove(world, b, true));
    this.balls = {};
  }

  private colorForTeam(teamId: string): string {
    let hash = 0;
    for (let i = 0; i < teamId.length; i++) {
      hash = teamId.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 60%)`;
  }
}
