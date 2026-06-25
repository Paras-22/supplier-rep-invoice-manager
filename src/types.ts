export interface Product {
  id: string;
  name: string;
  sku?: string;
  category?: string;
  lowStock: boolean;
  minStockLevel?: number;
  currentStock?: number;
  preferredRepId?: string | null;
  createdAt: any;
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
  packQuantity?: number;
  unitPrice?: number;
  discPercent?: number;
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
  packQuantity?: number;
  unitPrice?: number;
  discPercent?: number;
  // GST audit trail from DocketScanner's normalization step. gstStatus is
  // what Gemini detected on the docket's price column ("inclusive" means
  // the printed Unit Price already included GST and was divided by 1.15
  // before being stored here). originalUnitPriceIncGst preserves the raw
  // printed figure for that case, purely for the review-table badge — it
  // is never used in any price calculation downstream.
  gstStatus?: "inclusive" | "exclusive" | "unknown";
  originalUnitPriceIncGst?: number | null;
  matchedProductId?: string | null;
  matchedProductName?: string | null;
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
  id: string;
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