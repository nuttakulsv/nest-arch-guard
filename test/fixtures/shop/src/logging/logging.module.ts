import { Module } from '@nestjs/common'
import { Logger } from './logger.js'

const metadata = { providers: [Logger], exports: [Logger] }

@Module(metadata)
export class LoggingModule {}
