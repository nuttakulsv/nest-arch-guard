import { Injectable } from '@nestjs/common'

@Injectable()
export class Logger {
  log(message: string) {
    console.log(message)
  }
}
