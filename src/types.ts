export type Delivery = {
  id: number;
  date: string;
  cutoff: string;
  status: string;
  deliveryTime: string;
  editable: boolean;
  orderPath: string;
};

export type DishVariant = { id: number; name: string };

export type Dish = {
  id: number;
  revision: number;
  name: string;
  price: number;
  availableQuantity: number;
  variants: DishVariant[];
};

export type OrderItem = {
  dishId: number;
  variantId: number;
  revision: number;
  name: string;
  variantName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};
export type HistoricalOrderItem = {
  name: string;
  variantName: string;
  quantity: number;
  lineTotal: number;
};
export type HistoricalOrder = {
  deliveryId: number;
  date: string;
  status: string;
  items: HistoricalOrderItem[];
  total: number;
};

export type ParsedOrderPage = {
  deliveryId: number;
  form: Map<string, string[]>;
  deliveryTimes: string[];
  selectedDeliveryTimes: string[];
  dishes: Dish[];
  currentItems: OrderItem[];
  total: number;
  canOrder: boolean;
};
