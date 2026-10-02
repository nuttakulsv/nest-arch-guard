import { Inject, Injectable } from '@nestjs/common'
import { CONFIG_OPTIONS } from './tokens.js'

@Injectable()
export class ConfigService {
  constructor(@Inject(CONFIG_OPTIONS) private readonly options: { prefix: string }) {}

  get(key: string) {
    return process.env[`${this.options.prefix}_${key}`]
  }
}
