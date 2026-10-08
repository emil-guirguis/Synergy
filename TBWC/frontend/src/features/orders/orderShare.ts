import type { Order } from '../../types/order';

export const orderShareUrl = (order: Order) => `${window.location.origin}/orders?openId=${order.qb_sales_order_id}`;
export const orderShareTitle = (order: Order) => `Order ${order.ref_number ?? order.qb_sales_order_id}`;
