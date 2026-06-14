export interface Product {
  id: string; // SKU, Barcode, or auto-generated
  name: string;
  sku?: string;
  category?: string;
  lowStock: boolean;
  minStockLevel?: number;
  currentStock?: number;
  preferredRepId?: string | null;
  createdAt: any; // Firestore Timestamp
  updatedAt: any;
}

export interface Rep {
  id: string;
  name: string;
  company: string;
  email?: string;
  phone?: string;
  notes?: string;
  createdAt: any;
}

export interface Visit {
  id: string;
  repId: string;
  visitDate: any;
  notes: string;
  createdAt: any;
  createdBy: string;
}

export interface PriceEntry {
  id: string;
  productId: string;
  repId: string;
  price: number;
  packSize?: string;
  effectiveDate: any;
  invoiceId?: string;
  createdAt: any;
  createdBy: string;
}

export interface InvoiceItem {
  id?: string;
  name: string;
  code?: string | null;
  quantity: number;
  price: number;
  matchedProductId?: string | null;
}

export interface Invoice {
  id: string;
  fileUrl: string;
  fileName: string;
  repId?: string | null;
  repName?: string | null;
  invoiceDate?: string;
  totalAmount?: number;
  status: "pending_review" | "confirmed";
  items: InvoiceItem[];
  createdAt: any;
  createdBy: string;
}

export interface OrderItem {
  id: string; // unique item id inside list
  productId: string;
  productName: string;
  quantity: number;
  price: number;
}

export interface Order {
  id: string;
  repId: string;
  status: "draft" | "sent";
  totalCostEstimate?: number;
  items: OrderItem[];
  createdAt: any;
  createdBy: string;
}
