import React, { useState, useMemo } from "react";
import { AlertTriangle, ShieldCheck, ArrowRight, Phone, Mail, ChevronRight, RefreshCw, ShoppingCart, SlidersHorizontal, Package, Check, Sparkles } from "lucide-react";
import { doc, updateDoc, setDoc, collection, serverTimestamp } from "firebase/firestore";
import { db, handleFirestoreError, OperationType } from "../firebase";
import { Product, Rep, Order, OrderItem } from "../types";
import { motion } from "motion/react";

interface LowStockAlertsProps {
  products: Product[];
  reps: Rep[];
  currentUserUid: string;
  onNavigateToCatalog: () => void;
}

export default function LowStockAlerts({ products, reps, currentUserUid, onNavigateToCatalog }: LowStockAlertsProps) {
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [quantitiesToRefill, setQuantitiesToRefill] = useState<{ [prodId: string]: number }>({});
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [actionInProgressId, setActionInProgressId] = useState<string | null>(null);

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
    <div className="space-y-4" id="alerts_root">
      
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

        <div className="bg-slate-900 text-white rounded p-3 text-left relative overflow-hidden">
          <div className="absolute right-2.5 bottom-2 opacity-10">
            <Sparkles className="h-16 w-16 text-emerald-400" />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase font-bold tracking-wider text-slate-350">Quick Stock Replenish</span>
            <ShoppingCart className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="mt-2.5">
            <p className="text-[11px] font-bold text-slate-100">Spawn Requisitions Instantly</p>
            <p className="text-[9px] text-slate-350 mt-1 leading-tight">Generate pending draft requisitions linked straight to registered factory reps.</p>
          </div>
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

    </div>
  );
}
