import { type DynamicModule, Module } from '@nestjs/common'
import { ConfigService } from './config.service.js'
import { CONFIG_OPTIONS } from './tokens.js'

@Module({})
export class ConfigModule {
  static forRoot(options: { prefix: string }): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [ConfigService, { provide: CONFIG_OPTIONS, useValue: options }],
      exports: [ConfigService],
    }
  }
}
