import { Injectable } from '@nestjs/common'
import type { Order } from './domain/order.js'
import { OrdersService } from './orders.service.js'

@Injectable()
export class OrdersRepository {
  all(): Order[] {
    return []
  }

  static owner = OrdersService
}
