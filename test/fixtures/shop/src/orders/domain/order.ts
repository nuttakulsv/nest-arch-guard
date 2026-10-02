import { Injectable } from '@nestjs/common'

@Injectable()
export class Order {
  id = ''
  total = 0
}

export interface OrderSummary {
  id: string
  total: number
}
