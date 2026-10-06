import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { sweepConfig } from '../config/sweep.config.js';
import { SweepService } from './sweep.service.js';

@Injectable()
export class SweepScheduler implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SweepScheduler.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly service: SweepService,
    @Inject(sweepConfig.KEY) private readonly config: ConfigType<typeof sweepConfig>,
  ) {}

  onModuleInit() {
    if (!this.config.enableNativeSweeps) return;
    this.timer = setInterval(() => this.tick(), this.config.reconciliationIntervalMs);
    this.timer.unref();
    this.tick();
  }

  private tick() {
    if (this.running || this.stopped) return;
    this.running = this.service
      .scheduleEligible(100)
      .then(() => undefined)
      .catch(() => {
        this.logger.error('Sweep reconciliation failed; durable work will retry');
      })
      .finally(() => {
        this.running = undefined;
      });
  }

  async onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
