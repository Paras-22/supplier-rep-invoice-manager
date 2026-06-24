import React, { useState, useMemo } from "react";
import { AlertTriangle, ShieldCheck, ArrowRight, Phone, Mail, ChevronRight, RefreshCw, ShoppingCart, SlidersHorizontal, Package, Check, Sparkles, TrendingUp, Printer, Copy, Star } from "lucide-react";
import { doc, updateDoc, setDoc, collection, serverTimestamp } from "firebase/firestore";
import { db, handleFirestoreError, OperationType } from "../firebase";
import { Product, Rep, Order, OrderItem, PriceEntry } from "../types";
import { motion } from "motion/react";

interface LowStockAlertsProps {
  products: Product[];
  reps: Rep[];
  priceEntries: PriceEntry[];
  currentUserUid: string;
  onNavigateToCatalog: () => void;
}

// One detected price increase, ready to display in the sorted list.
interface PriceIncreaseAlert {
  productId: string;
  productName: string;
  repId: string;
  repName: string;
  repCompany: string;
  previousPrice: number;
  currentPrice: number;
  dollarChange: number;
  percentChange: number;
  effectiveDate: any;
}

// A single rep's current quote for a product, with per-unit (inc. GST)
// already computed — this is what makes prices from different pack
// sizes comparable.
interface RepQuote {
  repId: string;
  repName: string;
  repCompany: string;
  boxPrice: number;
  packQuantity: number;
  perUnitIncGst: number;
}

// A product supplied by 2+ reps, with all their current quotes and which
// one is cheapest.
interface MultiSupplierProduct {
  productId: string;
  productName: string;
  quotes: RepQuote[];
  cheapestRepId: string;
}

// A product flagged because its preferred rep setup needs attention —
// either no preferred rep is set at all, or the one that IS set isn't
// actually the cheapest option available right now.
interface PreferredRepIssue {
  productId: string;
  productName: string;
  reason: "none-set" | "not-cheapest";
  preferredRepName: string | null;
  preferredRepPrice: number | null;
  cheapestRepName: string;
  cheapestRepPrice: number;
  extraCostPerUnit: number | null;
}

export default function LowStockAlerts({ products, reps, priceEntries, currentUserUid, onNavigateToCatalog }: LowStockAlertsProps) {
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [quantitiesToRefill, setQuantitiesToRefill] = useState<{ [prodId: string]: number }>({});
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [actionInProgressId, setActionInProgressId] = useState<string | null>(null);
  // Relabeling sheet state: tracks whether the print preview modal is open,
  // and whether the "Copied!" confirmation should briefly show.
  const [showRelabelPrint, setShowRelabelPrint] = useState(false);
  const [copiedRelabelList, setCopiedRelabelList] = useState(false);

  // Categories extracted dynamically
  const categories = useMemo(() => {
    const list = new Set<string>();
    products.forEach(p => {
      if (p.category) list.add(p.category);
    });
    return Array.from(list);
  }, [products]);

  // Compute products below threshold
  const lowStockItems = useMemo(() => {
    return products.filter(p => {
      const minVal = p.minStockLevel ?? 0;
      const currentVal = p.currentStock ?? 0;
      
      // Determine if triggered low stock
      const isTriggered = (p.minStockLevel !== undefined && p.currentStock !== undefined)
        ? currentVal < minVal
        : p.lowStock;

      if (!isTriggered) return false;

      // Filter by category
      if (filterCategory !== "all" && p.category !== filterCategory) return false;

      // Filter by query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = p.name.toLowerCase().includes(q);
        const matchesSku = p.sku?.toLowerCase().includes(q) || p.id.toLowerCase().includes(q);
        if (!matchesName && !matchesSku) return false;
      }

      return true;
    });
  }, [products, filterCategory, searchQuery]);

  // Scans ALL price history across every product+rep combination, finds
  // every case where the latest recorded price is higher than the one
  // immediately before it, and returns those as a sorted list (biggest %
  // jump first). No time window or size threshold — every increase ever
  // recorded shows up here, by design (kept simple deliberately).
  const priceIncreases = useMemo(() => {
    const groups: { [key: string]: PriceEntry[] } = {};

    priceEntries.forEach(entry => {
      const key = `${entry.productId}__${entry.repId}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(entry);
    });

    const increases: PriceIncreaseAlert[] = [];

    Object.entries(groups).forEach(([key, entries]) => {
      if (entries.length < 2) return;

      const sorted = [...entries].sort((a, b) => {
        const timeA = a.effectiveDate?.seconds ? a.effectiveDate.seconds * 1000 : new Date(a.effectiveDate).getTime();
        const timeB = b.effectiveDate?.seconds ? b.effectiveDate.seconds * 1000 : new Date(b.effectiveDate).getTime();
        return timeB - timeA;
      });

      const current = sorted[0];
      const previous = sorted[1];

      if (current.price > previous.price) {
        const [productId, repId] = key.split("__");
        const product = products.find(p => p.id === productId);
        const rep = reps.find(r => r.id === repId);

        const dollarChange = current.price - previous.price;
        const percentChange = previous.price > 0 ? (dollarChange / previous.price) * 100 : 0;

        increases.push({
          productId,
          productName: product?.name || productId,
          repId,
          repName: rep?.name || "Unknown Rep",
          repCompany: rep?.company || "Unknown",
          previousPrice: previous.price,
          currentPrice: current.price,
          dollarChange,
          percentChange,
          effectiveDate: current.effectiveDate
        });
      }
    });

    return increases.sort((a, b) => b.percentChange - a.percentChange);
  }, [priceEntries, products, reps]);

  // For every product, find each rep's LATEST quote and compute per-unit
  // (inc. GST) for fair comparison across different pack sizes. Only
  // products with 2+ distinct reps quoting them are kept — a single-
  // supplier product has nothing to compare. This is the foundation both
  // the Cheapest Supplier section AND the Preferred Rep Action section
  // are built on, since they're really the same underlying data viewed
  // two different ways.
  const multiSupplierProducts = useMemo(() => {
    const latestByProductRep: { [key: string]: PriceEntry } = {};

    priceEntries.forEach(entry => {
      const key = `${entry.productId}__${entry.repId}`;
      const existing = latestByProductRep[key];
      if (!existing) {
        latestByProductRep[key] = entry;
        return;
      }
      const existingTime = existing.effectiveDate?.seconds ? existing.effectiveDate.seconds * 1000 : new Date(existing.effectiveDate).getTime();
      const entryTime = entry.effectiveDate?.seconds ? entry.effectiveDate.seconds * 1000 : new Date(entry.effectiveDate).getTime();
      if (entryTime > existingTime) latestByProductRep[key] = entry;
    });

    const byProduct: { [productId: string]: RepQuote[] } = {};

    Object.values(latestByProductRep).forEach(entry => {
      const packQty = entry.packQuantity;
      if (!packQty || packQty <= 0) return;
      const rep = reps.find(r => r.id === entry.repId);
      if (!rep) return;

      const perUnitIncGst = (entry.price / packQty) * 1.15;

      if (!byProduct[entry.productId]) byProduct[entry.productId] = [];
      byProduct[entry.productId].push({
        repId: entry.repId,
        repName: rep.name,
        repCompany: rep.company,
        boxPrice: entry.price,
        packQuantity: packQty,
        perUnitIncGst
      });
    });

    const result: MultiSupplierProduct[] = [];

    Object.entries(byProduct).forEach(([productId, quotes]) => {
      if (quotes.length < 2) return;
      const product = products.find(p => p.id === productId);
      if (!product) return;

      const sortedQuotes = [...quotes].sort((a, b) => a.perUnitIncGst - b.perUnitIncGst);
      const cheapestRepId = sortedQuotes[0].repId;

      result.push({
        productId,
        productName: product.name,
        quotes: sortedQuotes,
        cheapestRepId
      });
    });

    return result.sort((a, b) => a.productName.localeCompare(b.productName));
  }, [priceEntries, products, reps]);

  // Cross-references multiSupplierProducts against each product's
  // preferredRepId. Flags two distinct situations under one combined list,
  // with the reason shown per row: either no preferred rep has been set at
  // all, or one IS set but a cheaper option now exists and hasn't been
  // switched to.
  const preferredRepIssues = useMemo(() => {
    const issues: PreferredRepIssue[] = [];

    multiSupplierProducts.forEach(msp => {
      const product = products.find(p => p.id === msp.productId);
      if (!product) return;

      const cheapestQuote = msp.quotes.find(q => q.repId === msp.cheapestRepId)!;

      if (!product.preferredRepId) {
        issues.push({
          productId: msp.productId,
          productName: msp.productName,
          reason: "none-set",
          preferredRepName: null,
          preferredRepPrice: null,
          cheapestRepName: `${cheapestQuote.repName} (${cheapestQuote.repCompany})`,
          cheapestRepPrice: cheapestQuote.perUnitIncGst,
          extraCostPerUnit: null
        });
        return;
      }

      if (product.preferredRepId !== msp.cheapestRepId) {
        const preferredQuote = msp.quotes.find(q => q.repId === product.preferredRepId);
        if (preferredQuote) {
          issues.push({
            productId: msp.productId,
            productName: msp.productName,
            reason: "not-cheapest",
            preferredRepName: `${preferredQuote.repName} (${preferredQuote.repCompany})`,
            preferredRepPrice: preferredQuote.perUnitIncGst,
            cheapestRepName: `${cheapestQuote.repName} (${cheapestQuote.repCompany})`,
            cheapestRepPrice: cheapestQuote.perUnitIncGst,
            extraCostPerUnit: preferredQuote.perUnitIncGst - cheapestQuote.perUnitIncGst
          });
        }
      }
    });

    // Biggest overpay first, then "none set" issues after.
    return issues.sort((a, b) => (b.extraCostPerUnit ?? 0) - (a.extraCostPerUnit ?? 0));
  }, [multiSupplierProducts, products]);

  // Builds the same Product / Old / New / Rep / % info as the on-screen
  // table into a plain-text block, and copies it to the clipboard — same
  // pattern as the purchase-order copy button in RepDirectory.
  const handleCopyRelabelList = () => {
    if (priceIncreases.length === 0) return;
    let output = `--- CHAPEL DOWNS SUPERMARKET - PRICE CHANGES (UPDATE SHELF TAGS) ---\n`;
    output += `Generated: ${new Date().toLocaleString()}\n`;
    output += `--------------------------------------------------\n`;
    priceIncreases.forEach((inc, idx) => {
      output += `${idx + 1}. ${inc.productName}\n`;
      output += `   Was $${inc.previousPrice.toFixed(2)} -> Now $${inc.currentPrice.toFixed(2)} (+${inc.percentChange.toFixed(1)}%)\n`;
      output += `   Rep: ${inc.repName} (${inc.repCompany})\n`;
    });
    output += `--------------------------------------------------\n`;
    output += `Total products with price increases: ${priceIncreases.length}\n`;
    navigator.clipboard.writeText(output);
    setCopiedRelabelList(true);
    setTimeout(() => setCopiedRelabelList(false), 3000);
  };

  // Quick inline stock updates
  const handleModifyStock = async (productId: string, newQty: number, minLevel: number) => {
    setActionInProgressId(productId);
    try {
      const docRef = doc(db, "products", productId);
      // Automatically keep lowStock flag synchronized with calculations
      const isLowNow = newQty < minLevel;

      await updateDoc(docRef, {
        currentStock: newQty,
        lowStock: isLowNow,
        updatedAt: serverTimestamp()
      });

      setSuccessMessage(`Updated stock count for product ID: ${productId}`);
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `products/${productId}`);
    } finally {
      setActionInProgressId(null);
    }
  };

  // Adjust threshold level
  const handleModifyThreshold = async (productId: string, currentQty: number, newMinLevel: number) => {
    setActionInProgressId(productId);
    try {
      const docRef = doc(db, "products", productId);
      const isLowNow = currentQty < newMinLevel;

      await updateDoc(docRef, {
        minStockLevel: newMinLevel,
        lowStock: isLowNow,
        updatedAt: serverTimestamp()
      });

      setSuccessMessage(`Adjusted minimum threshold!`);
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `products/${productId}`);
    } finally {
      setActionInProgressId(null);
    }
  };

  // Sets a product's preferredRepId directly — used by the "Switch to
  // cheapest" quick-action button in the Preferred Rep Action section.
  const handleSetPreferredRep = async (productId: string, repId: string) => {
    setActionInProgressId(productId);
    try {
      await updateDoc(doc(db, "products", productId), {
        preferredRepId: repId,
        updatedAt: serverTimestamp()
      });
      setSuccessMessage(`Preferred supplier updated!`);
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `products/${productId}`);
    } finally {
      setActionInProgressId(null);
    }
  };

  // Automated draft order dispatch
  const handleCreateDraftOrder = async (product: Product, quantity: number) => {
    if (!product.preferredRepId) {
      alert("Please assign a preferred representative to this product first to order.");
      return;
    }
    if (quantity <= 0) {
      alert("Please enter a valid replenish quantity.");
      return;
    }

    setActionInProgressId(product.id);
    try {
      const orderRef = doc(collection(db, "orders"));
      const item: OrderItem = {
        id: "item_" + Date.now(),
        productId: product.id,
        productName: product.name,
        quantity: quantity,
        price: 0 // Will auto calculate or default with current supplier price
      };

      const orderPayload: Order = {
        id: orderRef.id,
        repId: product.preferredRepId,
        status: "draft",
        totalCostEstimate: 0,
        items: [item],
        createdAt: serverTimestamp(),
        createdBy: currentUserUid
      };

      await setDoc(orderRef, orderPayload);
      
      // Clear manual helper
      setQuantitiesToRefill(prev => ({ ...prev, [product.id]: 0 }));
      
      setSuccessMessage(`Draft requisition order created successfully!`);
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, "orders");
    } finally {
      setActionInProgressId(null);
    }
  };

  return (
    <div className="space-y-4" id="business_insights_root">

      {/* PAGE TITLE */}
      <div className="text-left">
        <h1 className="text-sm font-bold text-slate-900">Business Insights</h1>
        <p className="text-[10px] text-slate-400 mt-0.5">Stock urgency, price trends, and supplier comparison — everything that needs a decision, in one place.</p>
      </div>
      
      {/* ALERTS METRIC SUMMARY */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3" id="alerts_summary_panel">
        
        <div className="bg-rose-50 border border-rose-200 rounded p-3 text-left">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase font-bold tracking-wider text-rose-800">Critical Alerts Active</span>
            <AlertTriangle className="h-4 w-4 text-rose-700 animate-pulse" />
          </div>
          <div className="flex items-baseline gap-1.5 mt-2">
            <span className="text-xl font-extrabold text-rose-950 font-mono">{lowStockItems.length}</span>
            <span className="text-[9px] text-rose-700 font-sans">SKUs needing urgent reordering</span>
          </div>
          <p className="text-[9px] text-rose-600 mt-1 leading-tight font-serif">On-hand counts have fallen below the configured supermarket safety thresholds.</p>
        </div>

        <div className="bg-emerald-50 border border-emerald-250 rounded p-3 text-left">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase font-bold tracking-wider text-emerald-800">Store Capacity Health</span>
            <ShieldCheck className="h-4 w-4 text-emerald-700" />
          </div>
          <div className="flex items-baseline gap-1.5 mt-2">
            <span className="text-xl font-extrabold text-emerald-950 font-mono">
              {products.length ? Math.round(((products.length - products.filter(p => p.lowStock).length) / products.length) * 100) : 100}%
            </span>
            <span className="text-[9px] text-emerald-700">Healthy SKU ratio</span>
          </div>
          <p className="text-[9px] text-emerald-600 mt-1 leading-tight font-sans">Portion of master database currently in compliance with standard levels.</p>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded p-3 text-left relative overflow-hidden">
          <div className="absolute right-2.5 bottom-2 opacity-10">
            <TrendingUp className="h-16 w-16 text-amber-600" />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase font-bold tracking-wider text-amber-800">Price Increases</span>
            <TrendingUp className="h-4 w-4 text-amber-700" />
          </div>
          <div className="flex items-baseline gap-1.5 mt-2">
            <span className="text-xl font-extrabold text-amber-950 font-mono">{priceIncreases.length}</span>
            <span className="text-[9px] text-amber-700 font-sans">supplier prices have gone up</span>
          </div>
          <p className="text-[9px] text-amber-600 mt-1 leading-tight font-sans">Across every rep and product on file, biggest jump first.</p>
        </div>

      </div>

      {/* FILTER CONTROLS BAR */}
      <div className="bg-white rounded border border-slate-200 p-2.5 flex flex-col sm:flex-row items-center justify-between gap-3 text-left">
        
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <span className="p-1 bg-slate-100 rounded text-slate-500 shrink-0">
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </span>
          <div className="leading-tight">
            <span className="text-[11px] font-bold text-slate-800">Alert Filters</span>
            <p className="text-[9px] text-slate-400 leading-none">Isolate priority supermarket departments</p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto sm:items-center">
          {/* SEARCH FIELD */}
          <input
            type="text"
            className="text-[10px] p-1 px-2 border border-slate-200 bg-slate-50 rounded focus:outline-none focus:bg-white w-full sm:w-44"
            placeholder="Search matching alert names..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          {/* CATEGORY SELECTOR */}
          <select
            className="text-[10px] p-1 border border-slate-200 bg-slate-50 rounded focus:outline-none focus:bg-white leading-normal"
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
          >
            <option value="all">All Categories ({products.length})</option>
            {categories.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

      </div>

      {/* SUCCESS BANNER */}
      {successMessage && (
        <motion.div
          initial={{ opacity: 0, y: -2 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-2 bg-emerald-550 border border-emerald-650 rounded text-white text-[10px] font-semibold text-center"
        >
          {successMessage}
        </motion.div>
      )}

      {/* PRICE INCREASE ALERTS */}
      <div className="bg-white rounded border border-slate-200 overflow-hidden" id="price_increase_panel">
        <div className="p-3 bg-amber-50 border-b border-amber-200 flex items-center justify-between gap-2 flex-wrap">
          <div className="text-left leading-tight">
            <h3 className="text-[11px] font-bold text-amber-900 flex items-center gap-1">
              <TrendingUp className="h-3.5 w-3.5" />
              Supplier Price Increases
            </h3>
            <p className="text-[9px] text-amber-700">Every product where the latest recorded price is higher than the one before it, sorted by biggest jump first.</p>
          </div>
          {priceIncreases.length > 0 && (
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={handleCopyRelabelList}
                className="px-2 py-1 bg-white hover:bg-amber-100 border border-amber-300 text-amber-800 rounded text-[9px] font-bold flex items-center gap-1 cursor-pointer transition-colors"
              >
                {copiedRelabelList ? <><Check className="h-3 w-3" /><span>Copied!</span></> : <><Copy className="h-3 w-3" /><span>Copy List</span></>}
              </button>
              <button
                onClick={() => setShowRelabelPrint(true)}
                className="px-2 py-1 bg-amber-700 hover:bg-amber-800 text-white rounded text-[9px] font-bold flex items-center gap-1 cursor-pointer transition-colors"
              >
                <Printer className="h-3 w-3" /><span>Print Relabel Sheet</span>
              </button>
            </div>
          )}
        </div>

        {priceIncreases.length === 0 ? (
          <div className="p-8 text-center flex flex-col items-center justify-center">
            <div className="bg-emerald-50 rounded-full p-2.5 text-emerald-600 mb-2">
              <ShieldCheck className="h-5 w-5 stroke-[2px]" />
            </div>
            <h3 className="text-xs font-bold text-slate-800">No price increases on file</h3>
            <p className="text-[10px] text-slate-400 mt-0.5 max-w-sm leading-normal">
              Every product's latest price is the same as or lower than its previous price, across all reps.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <table className="w-full text-left text-[10px] font-sans">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase font-bold text-[8px] tracking-wider leading-none">
                  <th className="p-2 px-3">Product</th>
                  <th className="p-2 px-3">Rep</th>
                  <th className="p-2 px-3 text-right">Was</th>
                  <th className="p-2 px-3 text-right">Now</th>
                  <th className="p-2 px-3 text-right">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {priceIncreases.map((inc, idx) => (
                  <tr key={`${inc.productId}-${inc.repId}-${idx}`} className="hover:bg-amber-50/30">
                    <td className="p-2 px-3">
                      <p className="font-bold text-slate-800 line-clamp-1">{inc.productName}</p>
                      <p className="text-[8px] text-slate-400 font-mono">{inc.productId}</p>
                    </td>
                    <td className="p-2 px-3">
                      <p className="font-semibold text-slate-700 leading-tight">{inc.repName}</p>
                      <p className="text-[8px] text-slate-400 uppercase">{inc.repCompany}</p>
                    </td>
                    <td className="p-2 px-3 text-right font-mono text-slate-400">${inc.previousPrice.toFixed(2)}</td>
                    <td className="p-2 px-3 text-right font-mono font-bold text-slate-800">${inc.currentPrice.toFixed(2)}</td>
                    <td className="p-2 px-3 text-right">
                      <span className="font-bold text-[9px] text-rose-700 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded">
                        +${inc.dollarChange.toFixed(2)} (+{inc.percentChange.toFixed(1)}%)
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* CHEAPEST SUPPLIER COMPARISON */}
      <div className="bg-white rounded border border-slate-200 overflow-hidden" id="cheapest_supplier_panel">
        <div className="p-3 bg-emerald-50 border-b border-emerald-200">
          <h3 className="text-[11px] font-bold text-emerald-900 flex items-center gap-1">
            <Star className="h-3.5 w-3.5" />
            Cheapest Supplier Comparison
          </h3>
          <p className="text-[9px] text-emerald-700">Every product quoted by more than one rep, compared by per-unit cost (incl. GST) so different pack sizes are comparable. Cheapest rep marked.</p>
        </div>

        {multiSupplierProducts.length === 0 ? (
          <div className="p-8 text-center flex flex-col items-center justify-center">
            <p className="text-[10px] text-slate-400 max-w-sm leading-normal">
              No products are currently quoted by more than one rep — nothing to compare yet.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-left text-[10px] font-sans">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase font-bold text-[8px] tracking-wider leading-none">
                  <th className="p-2 px-3">Product</th>
                  <th className="p-2 px-3">Supplier Quotes (Per Unit, incl. GST)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {multiSupplierProducts.map(msp => (
                  <tr key={msp.productId} className="hover:bg-emerald-50/20 align-top">
                    <td className="p-2 px-3 min-w-[140px]">
                      <p className="font-bold text-slate-800">{msp.productName}</p>
                      <p className="text-[8px] text-slate-400 font-mono">{msp.productId}</p>
                    </td>
                    <td className="p-2 px-3">
                      <div className="flex flex-wrap gap-1.5">
                        {msp.quotes.map(q => {
                          const isCheapest = q.repId === msp.cheapestRepId;
                          return (
                            <span
                              key={q.repId}
                              className={`px-1.5 py-1 rounded border text-[9px] flex items-center gap-1 ${isCheapest ? "bg-emerald-50 border-emerald-300 text-emerald-800 font-bold" : "bg-slate-50 border-slate-200 text-slate-600"}`}
                            >
                              {isCheapest && <Star className="h-2.5 w-2.5 fill-emerald-500 text-emerald-500" />}
                              <span>{q.repName} ({q.repCompany})</span>
                              <span className="font-mono">${q.perUnitIncGst.toFixed(2)}</span>
                            </span>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* PREFERRED REP ACTION NEEDED */}
      <div className="bg-white rounded border border-slate-200 overflow-hidden" id="preferred_rep_action_panel">
        <div className="p-3 bg-indigo-50 border-b border-indigo-200">
          <h3 className="text-[11px] font-bold text-indigo-900 flex items-center gap-1">
            <ArrowRight className="h-3.5 w-3.5" />
            Preferred Rep — Action Needed
          </h3>
          <p className="text-[9px] text-indigo-700">Multi-supplier products that either have no preferred rep set, or whose preferred rep isn't currently the cheapest available.</p>
        </div>

        {preferredRepIssues.length === 0 ? (
          <div className="p-8 text-center flex flex-col items-center justify-center">
            <div className="bg-emerald-50 rounded-full p-2.5 text-emerald-600 mb-2">
              <ShieldCheck className="h-5 w-5 stroke-[2px]" />
            </div>
            <h3 className="text-xs font-bold text-slate-800">All preferred reps are optimal</h3>
            <p className="text-[10px] text-slate-400 mt-0.5 max-w-sm leading-normal">
              Every multi-supplier product has a preferred rep set, and it's currently the cheapest option.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-left text-[10px] font-sans">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase font-bold text-[8px] tracking-wider leading-none">
                  <th className="p-2 px-3">Product</th>
                  <th className="p-2 px-3">Issue</th>
                  <th className="p-2 px-3 text-right">Extra Cost / Unit</th>
                  <th className="p-2 px-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {preferredRepIssues.map(issue => (
                  <tr key={issue.productId} className="hover:bg-indigo-50/20">
                    <td className="p-2 px-3 min-w-[140px]">
                      <p className="font-bold text-slate-800">{issue.productName}</p>
                    </td>
                    <td className="p-2 px-3">
                      {issue.reason === "none-set" ? (
                        <span className="text-[9px] text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded font-bold">No preferred rep set</span>
                      ) : (
                        <div className="space-y-0.5">
                          <span className="text-[9px] text-rose-700 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded font-bold">Not cheapest</span>
                          <p className="text-[8px] text-slate-500">Currently: {issue.preferredRepName} (${issue.preferredRepPrice?.toFixed(2)}/unit)</p>
                        </div>
                      )}
                      <p className="text-[8px] text-emerald-700 mt-0.5">Cheapest: {issue.cheapestRepName} (${issue.cheapestRepPrice.toFixed(2)}/unit)</p>
                    </td>
                    <td className="p-2 px-3 text-right font-mono font-bold text-rose-700">
                      {issue.extraCostPerUnit !== null ? `+$${issue.extraCostPerUnit.toFixed(2)}` : "—"}
                    </td>
                    <td className="p-2 px-3 text-right">
                      <button
                        onClick={() => {
                          const msp = multiSupplierProducts.find(m => m.productId === issue.productId);
                          if (msp) handleSetPreferredRep(issue.productId, msp.cheapestRepId);
                        }}
                        disabled={actionInProgressId === issue.productId}
                        className="px-1.5 py-1 bg-emerald-700 hover:bg-emerald-800 text-white rounded text-[9px] font-bold cursor-pointer disabled:opacity-50"
                      >
                        Switch to cheapest
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* DETAILED ACTIVE COMPLIANCE SHIELD / ALERTS LIST */}
      <div className="bg-white rounded border border-slate-200 overflow-hidden" id="alerts_table_panel">
        <div className="p-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <div className="text-left leading-tight">
            <h3 className="text-[11px] font-bold text-slate-850">Triggered Inventory Discrepancy Rows</h3>
            <p className="text-[9px] text-slate-400">Products where Current On-hand quantity falls below required Minimum Thresholds.</p>
          </div>
          <button
            onClick={onNavigateToCatalog}
            className="px-2 py-0.5 border border-slate-300 hover:bg-slate-100 text-[9px] font-semibold text-slate-700 rounded transition-colors cursor-pointer"
          >
            Manage Product Catalog
          </button>
        </div>

        {lowStockItems.length === 0 ? (
          <div className="p-10 text-center flex flex-col items-center justify-center">
            <div className="bg-emerald-50 rounded-full p-2.5 text-emerald-600 mb-2">
              <ShieldCheck className="h-6 w-6 stroke-[2px]" />
            </div>
            <h3 className="text-xs font-bold text-slate-800">All Supermarket Stocks Compliant</h3>
            <p className="text-[10px] text-slate-405 mt-0.5 max-w-sm leading-normal">
              Zero alarms logged! Every product has on-hand physical inventories matching or exceeding safety thresholds set in Auckland master catalog, or no thresholds have been designed.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[10px] font-sans">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase font-bold text-[8px] tracking-wider leading-none">
                  <th className="p-2 px-3">Product Name &amp; SKU</th>
                  <th className="p-2 px-3 text-center">Safety Threshold</th>
                  <th className="p-2 px-3 text-center">Current On-Hand</th>
                  <th className="p-2 px-3">Action: Quick Count Update</th>
                  <th className="p-2 px-3">Preferred Supplier Rep</th>
                  <th className="p-2 px-3 text-right">Draft Requisition</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lowStockItems.map(p => {
                  const matchedRep = reps.find(r => r.id === p.preferredRepId);
                  const minLevel = p.minStockLevel ?? 0;
                  const currentQty = p.currentStock ?? 0;
                  const refillNeededVal = minLevel - currentQty;
                  
                  // Local buffer value for manual input refill amount
                  const refillAmount = quantitiesToRefill[p.id] ?? (refillNeededVal > 0 ? refillNeededVal : 5);

                  return (
                    <tr key={p.id} className="hover:bg-slate-50/40">
                      
                      {/* NAME & SKU DETAIL */}
                      <td className="p-2.5 px-3">
                        <div className="font-bold text-slate-800 text-[11px] leading-tight flex items-baseline gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-rose-600 shrink-0 inline-block"></span>
                          <span className="line-clamp-1">{p.name}</span>
                        </div>
                        <div className="flex gap-1.5 items-center mt-1 text-[8px] text-slate-400 font-mono">
                          <span>Bar: {p.id}</span>
                          <span className="px-1 bg-slate-100 text-slate-500 text-[7px] leading-none capitalize rounded">{p.category || "General"}</span>
                        </div>
                      </td>

                      {/* SAFETY THRESHOLD INPUT */}
                      <td className="p-2.5 px-3 text-center">
                        <div className="inline-flex items-center justify-center gap-1">
                          <input
                            type="number"
                            min="0"
                            className="w-10 text-center font-bold bg-slate-50/85 border border-slate-200 hover:border-slate-350 p-0.5 rounded text-[10px] focus:outline-none focus:bg-white"
                            value={minLevel}
                            disabled={actionInProgressId === p.id}
                            onChange={(e) => handleModifyThreshold(p.id, currentQty, parseInt(e.target.value) || 0)}
                          />
                          <span className="text-[8px] text-slate-400">units</span>
                        </div>
                      </td>

                      {/* CURRENT ON-HAND COUNT WITH COLOR WARNING */}
                      <td className="p-2.5 px-3 text-center">
                        <div className="px-1.5 py-0.5 rounded bg-rose-50 border border-rose-100 inline-block font-extrabold text-rose-900 font-mono text-[11px]" title="Qty on-hand is low">
                          {currentQty}
                        </div>
                      </td>

                      {/* QUICK MANUAL STOCK UPDATE BUTTONS */}
                      <td className="p-2.5 px-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleModifyStock(p.id, currentQty + 1, minLevel)}
                            disabled={actionInProgressId === p.id}
                            className="px-1.5 py-1 bg-slate-100 hover:bg-slate-200 border border-slate-250 text-slate-800 rounded text-[9px] font-semibold cursor-pointer"
                            title="Increase physical inventory by 1"
                          >
                            +1 Unit
                          </button>
                          <button
                            onClick={() => handleModifyStock(p.id, minLevel + 5, minLevel)}
                            disabled={actionInProgressId === p.id}
                            className="px-1.5 py-1 bg-emerald-700 hover:bg-emerald-800 text-white rounded text-[9px] font-bold cursor-pointer transition-colors shadow-2xs"
                            title="Refill stock fully up to safety requirement + 5 extra units buffer"
                          >
                            Set to {minLevel + 5}
                          </button>
                        </div>
                      </td>

                      {/* PREFERRED SUPPLIER CARD */}
                      <td className="p-2.5 px-3">
                        {matchedRep ? (
                          <div className="space-y-0.5">
                            <p className="font-bold text-slate-800 leading-tight">{matchedRep.name}</p>
                            <p className="text-[8px] font-semibold text-emerald-800 uppercase tracking-tight leading-none text-left">{matchedRep.company}</p>
                            
                            <div className="flex items-center gap-2 mt-1 text-slate-400">
                              {matchedRep.phone && (
                                <a href={`tel:${matchedRep.phone}`} title="Call Representative" className="hover:text-emerald-700">
                                  <Phone className="h-3 w-3" />
                                </a>
                              )}
                              {matchedRep.email && (
                                <a href={`mailto:${matchedRep.email}`} title="Email Representative" className="hover:text-emerald-700">
                                  <Mail className="h-3 w-3" />
                                </a>
                              )}
                            </div>
                          </div>
                        ) : (
                          <span className="text-[9px] text-amber-650 italic">No rep assigned</span>
                        )}
                      </td>

                      {/* LINKED ORDER PLACEMENTS */}
                      <td className="p-2.5 px-3 text-right">
                        {p.preferredRepId ? (
                          <div className="inline-flex items-center justify-end gap-1.5">
                            <div className="flex items-center space-x-1">
                              <span className="text-[8px] text-slate-400">Order:</span>
                              <input
                                type="number"
                                min="1"
                                className="w-8 text-center p-0.5 border border-slate-200 bg-slate-50 text-[9px] font-bold rounded"
                                value={refillAmount}
                                onChange={(e) => setQuantitiesToRefill({ ...quantitiesToRefill, [p.id]: Math.max(1, parseInt(e.target.value) || 0) })}
                              />
                            </div>
                            <button
                              onClick={() => handleCreateDraftOrder(p, refillAmount)}
                              disabled={actionInProgressId === p.id}
                              className="p-1 px-2 border border-slate-900 bg-slate-900 hover:bg-slate-800 text-white rounded text-[9px] font-bold flex items-center gap-1 cursor-pointer transition-colors"
                              title="Generate an official draft quotation sheet on the staff orders pipeline"
                            >
                              <ShoppingCart className="h-3 w-3 shrink-0" />
                              <span>Draft</span>
                            </button>
                          </div>
                        ) : (
                          <span className="text-[8px] text-slate-400 font-mono">Must link rep inside catalog</span>
                        )}
                      </td>

                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* RELABEL PRINT MODAL */}
      {showRelabelPrint && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 overflow-y-auto">
          <div className="bg-white rounded-lg shadow-2xl border border-slate-200 w-full max-w-3xl p-6 relative max-h-[90vh] overflow-y-auto flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-4 no-print">
              <div className="flex items-center gap-2">
                <Printer className="h-4 w-4 text-amber-700" />
                <h2 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider">Price Changes — Relabel Sheet</h2>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => window.print()} className="p-1.5 px-3 bg-amber-700 hover:bg-amber-800 text-white rounded text-[11px] font-bold flex items-center gap-1.5 cursor-pointer">
                  <Printer className="h-3.5 w-3.5" /><span>Print</span>
                </button>
                <button onClick={() => setShowRelabelPrint(false)} className="p-1.5 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-[11px] font-bold cursor-pointer border border-slate-200">Close</button>
              </div>
            </div>

            <div id="printable-relabel-area" className="flex-1 bg-white text-slate-900 p-6 rounded border border-slate-200 font-sans">
              <style>{`@media print { body * { visibility: hidden !important; } #printable-relabel-area, #printable-relabel-area * { visibility: visible !important; } #printable-relabel-area { position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important; padding: 40px !important; } }`}</style>

              <div className="border-b-4 border-amber-700 pb-3 mb-6 flex items-center justify-between">
                <div>
                  <h1 className="text-lg font-black text-amber-800 tracking-wider">CHAPEL DOWNS SUPERMARKET</h1>
                  <p className="text-[9px] text-slate-500 uppercase tracking-widest font-semibold">Price Changes — Update Shelf Tags</p>
                </div>
                <div className="text-right">
                  <span className="text-[9px] font-mono font-bold bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{priceIncreases.length} Products</span>
                  <p className="text-[8px] font-mono text-slate-400 mt-1">Printed: {new Date().toLocaleString()}</p>
                </div>
              </div>

              <table className="w-full text-[10px] border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-[8px] uppercase text-slate-500 font-bold">
                    <th className="p-2 text-left">#</th>
                    <th className="p-2 text-left">Product</th>
                    <th className="p-2 text-left">Rep</th>
                    <th className="p-2 text-right">Old Price</th>
                    <th className="p-2 text-right">New Price</th>
                    <th className="p-2 text-right">Change</th>
                    <th className="p-2 text-center">Done?</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-150">
                  {priceIncreases.map((inc, idx) => (
                    <tr key={`${inc.productId}-${inc.repId}-${idx}`}>
                      <td className="p-2 text-slate-400 font-mono">{idx + 1}</td>
                      <td className="p-2 font-semibold text-slate-800">{inc.productName}</td>
                      <td className="p-2 text-slate-600">{inc.repName} ({inc.repCompany})</td>
                      <td className="p-2 text-right font-mono text-slate-400">${inc.previousPrice.toFixed(2)}</td>
                      <td className="p-2 text-right font-mono font-bold">${inc.currentPrice.toFixed(2)}</td>
                      <td className="p-2 text-right font-bold text-rose-700">+{inc.percentChange.toFixed(1)}%</td>
                      <td className="p-2 text-center">
                        <span className="inline-block w-3.5 h-3.5 border border-slate-400 rounded-sm"></span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="mt-8 border-t border-dashed border-slate-300 pt-4 text-[9px] text-slate-400">
                Chapel Downs Supermarket — Confidential procurement document. Check the box once a shelf tag has been updated.
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}