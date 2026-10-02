import { ConfigModule } from './config/config.module.js'
import { LoggingModule } from './logging/logging.module.js'

export const SHARED_MODULES = [ConfigModule.forRoot({ prefix: 'SHOP' }), LoggingModule]
