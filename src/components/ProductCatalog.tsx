import React, { useEffect, useRef } from "react";
import { Search, Star, AlertTriangle, AlertCircle, History, Landmark, PlusCircle, Bookmark, CheckCircle, Package, DollarSign, AlertOctagon, Edit2, Save, X, Trash2, Loader2 } from "lucide-react";
import { collection, doc, setDoc, updateDoc, deleteDoc, serverTimestamp, query, where, getDocs, limit, writeBatch } from "firebase/firestore";
import { db, handleFirestoreError, OperationType } from "../firebase";
import { Product, Rep, PriceEntry } from "../types";
import { motion } from "motion/react";
import { useState, useMemo } from "react";

interface ProductCatalogProps {
  reps: Rep[];
  priceEntries: PriceEntry[];
  currentUserUid: string;
  // Lifted up to App.tsx so this state survives tab switches — this
  // component used to keep these as local useState, but App.tsx unmounts
  // this component when switching tabs, which wiped the search every time.
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  searchResults: Product[];
  setSearchResults: (value: Product[]) => void;
  selectedProductId: string;
  setSelectedProductId: (value: string) => void;
}

export default function ProductCatalog({
  reps,
  priceEntries,
  currentUserUid,
  searchQuery,
  setSearchQuery,
  searchResults,
  setSearchResults,
  selectedProductId,
  setSelectedProductId
}: ProductCatalogProps) {
  const [isSearching, setIsSearching] = useState(false);
  const [manualRepId, setManualRepId] = useState("");
  const [manualPrice, setManualPrice] = useState("");
  const [manualPack, setManualPack] = useState("Single Unit");
  const [manualSuccess, setManualSuccess] = useState(false);
  const [currentStockInput, setCurrentStockInput] = useState<string>("");
  const [minStockInput, setMinStockInput] = useState<string>("");
  const [stockSuccess, setStockSuccess] = useState(false);

  // Inline pricing-edit state. isEditingPricing toggles the Cost/Selling
  // boxes into editable inputs; the draft values live here until Save is
  // pressed, so cancelling never partially-commits a half-typed edit.
  const [isEditingPricing, setIsEditingPricing] = useState(false);
  const [pricingCostInput, setPricingCostInput] = useState("");
  const [pricingSellingInput, setPricingSellingInput] = useState("");
  const [isSavingPricing, setIsSavingPricing] = useState(false);
  const [pricingSaveSuccess, setPricingSaveSuccess] = useState(false);

  // Delete-product state. showDeleteConfirm opens the confirm panel;
  // acknowledgeCascade must be explicitly checked when the product HAS
  // price history before the delete button activates — this mirrors the
  // same "type to confirm" discipline RepDirectory uses for deleting a
  // rep, just expressed as a checkbox here since the stakes (one
  // product's history, not a rep's whole relationship) are slightly lower.
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [acknowledgeCascade, setAcknowledgeCascade] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Reference to the product detail panel container. When a product is
  // tapped on mobile, the scroll position otherwise stays exactly where it
  // was — often still showing the search results list — leaving no visual
  // cue that anything happened until the user manually scrolls down. This
  // ref lets us smooth-scroll the detail panel into view right after
  // selection, same pattern used for rep selection in RepDirectory.
  const productDetailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const searchProducts = async () => {
      if (!searchQuery.trim() || searchQuery.trim().length < 2) {
        setSearchResults([]);
        return;
      }
      setIsSearching(true);
      try {
        const q = searchQuery.trim().toUpperCase();
        const snapshot = await getDocs(
          query(
            collection(db, "products"),
            where("name", ">=", q),
            where("name", "<=", q + "\uf8ff"),
            limit(20)
          )
        );
        const results: Product[] = [];
        snapshot.forEach(doc => {
          results.push({ id: doc.id, ...doc.data() } as Product);
        });
        setSearchResults(results);
      } catch (err) {
        console.error("Search error:", err);
      } finally {
        setIsSearching(false);
      }
    };

    const debounce = setTimeout(searchProducts, 400);
    return () => clearTimeout(debounce);
  }, [searchQuery]);

  const selectedProduct = useMemo(() => {
    return searchResults.find(p => p.id === selectedProductId) || null;
  }, [searchResults, selectedProductId]);

  // Selects a product and smooth-scrolls the detail panel into view. The
  // small delay lets selectedProduct (which depends on selectedProductId)
  // actually update and render before we try to scroll to its container.
  const handleSelectProduct = (productId: string) => {
    setSelectedProductId(productId);
    setIsEditingPricing(false);
    setShowDeleteConfirm(false);
    setAcknowledgeCascade(false);
    setDeleteError(null);
    setTimeout(() => {
      productDetailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  };

  const productPriceHistory = useMemo(() => {
    if (!selectedProductId) return [];
    return priceEntries
      .filter(p => p.productId === selectedProductId)
      .sort((a, b) => {
        const timeA = a.effectiveDate?.seconds || new Date(a.effectiveDate).getTime() / 1000;
        const timeB = b.effectiveDate?.seconds || new Date(b.effectiveDate).getTime() / 1000;
        return timeB - timeA;
      });
  }, [priceEntries, selectedProductId]);

  // Distinct reps that have ever quoted this product — used only in the
  // delete-confirmation copy, so the warning names WHO would lose history,
  // not just a bare count.
  const productPriceRepNames = useMemo(() => {
    const repIds = new Set(productPriceHistory.map(p => p.repId));
    return Array.from(repIds)
      .map(id => reps.find(r => r.id === id))
      .filter((r): r is Rep => !!r)
      .map(r => r.name);
  }, [productPriceHistory, reps]);

  const repCurrentPrices = useMemo(() => {
    if (!selectedProductId) return [];
    const latestPricesMap: { [repId: string]: PriceEntry } = {};
    productPriceHistory.forEach(entry => {
      if (!latestPricesMap[entry.repId]) {
        latestPricesMap[entry.repId] = entry;
      }
    });
    return Object.values(latestPricesMap);
  }, [productPriceHistory, selectedProductId]);

  const lowestPriceRepId = useMemo(() => {
    if (repCurrentPrices.length === 0) return null;
    let cheapest = repCurrentPrices[0];
    repCurrentPrices.forEach(item => {
      if (item.price < cheapest.price) cheapest = item;
    });
    return cheapest.repId;
  }, [repCurrentPrices]);

  // Helper: returns the per-unit price (excl. GST) for a price entry, using
  // packQuantity if present (new structured data), or falling back to null
  // for old entries that only have the legacy packSize string.
  const getPerUnit = (entry: PriceEntry): number | null => {
    const packQty = (entry as any).packQuantity;
    if (packQty && packQty > 0) return entry.price / packQty;
    return null;
  };

  // True only when the product has BOTH costPrice and sellingPrice
  // populated from the POS pricing import (POSImport.tsx's "Update
  // Pricing & Margins" mode) — or from a manual inline edit, which writes
  // both fields together too. Products imported before that patch was
  // run, or any barcode that didn't match during the import, simply won't
  // have these fields — shown as a clear "not available" state below
  // rather than silently rendering $0.00 or NaN.
  const hasPricingData = !!(selectedProduct?.costPrice && selectedProduct?.sellingPrice);

  // Opens the inline pricing editor, pre-filled with current values (or
  // blank if this product has no pricing data yet — same form doubles as
  // "add pricing for the first time").
  const handleStartEditPricing = () => {
    setPricingCostInput(selectedProduct?.costPrice != null ? selectedProduct.costPrice.toString() : "");
    setPricingSellingInput(selectedProduct?.sellingPrice != null ? selectedProduct.sellingPrice.toString() : "");
    setIsEditingPricing(true);
    setPricingSaveSuccess(false);
  };

  // Live preview of Margin/GP%/Markup% computed from whatever is currently
  // typed in the edit inputs — same arithmetic the POS pricing importer
  // uses, kept here so a manual edit can never drift out of sync with how
  // bulk-imported pricing is calculated.
  const pricingEditPreview = useMemo(() => {
    const cost = parseFloat(pricingCostInput);
    const selling = parseFloat(pricingSellingInput);
    if (isNaN(cost) || isNaN(selling) || cost <= 0 || selling <= 0) return null;
    const margin = Math.round((selling - cost) * 100) / 100;
    const gpPercent = Math.round(((selling - cost) / selling) * 10000) / 100;
    const markupPercent = Math.round(((selling - cost) / cost) * 10000) / 100;
    const pricingFlag = cost >= selling ? "LOSS_OR_BREAKEVEN" : "";
    return { cost, selling, margin, gpPercent, markupPercent, pricingFlag };
  }, [pricingCostInput, pricingSellingInput]);

  // Saves Cost Price / Selling Price and recomputes Margin/GP%/Markup%/
  // pricingFlag together, in code — never trusting stale values from
  // before the edit. This mirrors exactly what POSImport.tsx's pricing
  // patch writes, so a manual edit here and a bulk CSV re-import later
  // never disagree about how these numbers are derived.
  const handleSavePricing = async () => {
    if (!selectedProduct || !pricingEditPreview) return;
    setIsSavingPricing(true);
    try {
      const docRef = doc(db, "products", selectedProduct.id);
      const { cost, selling, margin, gpPercent, markupPercent, pricingFlag } = pricingEditPreview;
      await updateDoc(docRef, {
        costPrice: cost,
        sellingPrice: selling,
        margin,
        gpPercent,
        markupPercent,
        pricingFlag: pricingFlag || null,
        updatedAt: serverTimestamp()
      });
      setSearchResults(searchResults.map(p =>
        p.id === selectedProduct.id
          ? { ...p, costPrice: cost, sellingPrice: selling, margin, gpPercent, markupPercent, pricingFlag: pricingFlag || undefined }
          : p
      ));
      setIsEditingPricing(false);
      setPricingSaveSuccess(true);
      setTimeout(() => setPricingSaveSuccess(false), 3000);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `products/${selectedProduct.id}`);
    } finally {
      setIsSavingPricing(false);
    }
  };

  const handleToggleLowStock = async () => {
    if (!selectedProduct) return;
    const docRef = doc(db, "products", selectedProduct.id);
    try {
      await updateDoc(docRef, { lowStock: !selectedProduct.lowStock, updatedAt: serverTimestamp() });
      setSearchResults(searchResults.map(p => p.id === selectedProduct.id ? { ...p, lowStock: !p.lowStock } : p));
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `products/${selectedProduct.id}`);
    }
  };

  useEffect(() => {
    if (selectedProduct) {
      setCurrentStockInput(selectedProduct.currentStock?.toString() ?? "0");
      setMinStockInput(selectedProduct.minStockLevel?.toString() ?? "0");
    } else {
      setCurrentStockInput("");
      setMinStockInput("");
    }
  }, [selectedProductId, selectedProduct]);

  const handleSaveStockLevels = async () => {
    if (!selectedProduct) return;
    try {
      const curStock = parseInt(currentStockInput) || 0;
      const minStock = parseInt(minStockInput) || 0;
      const isLowStock = curStock < minStock;
      const docRef = doc(db, "products", selectedProduct.id);
      await updateDoc(docRef, {
        currentStock: curStock,
        minStockLevel: minStock,
        lowStock: isLowStock,
        updatedAt: serverTimestamp()
      });
      setSearchResults(searchResults.map(p =>
        p.id === selectedProduct.id ? { ...p, currentStock: curStock, minStockLevel: minStock, lowStock: isLowStock } : p
      ));
      setStockSuccess(true);
      setTimeout(() => setStockSuccess(false), 3000);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `products/${selectedProduct.id}`);
    }
  };

  const handleUpdatePreferredRep = async (repId: string) => {
    if (!selectedProduct) return;
    const docRef = doc(db, "products", selectedProduct.id);
    try {
      await updateDoc(docRef, { preferredRepId: repId || null, updatedAt: serverTimestamp() });
      setSearchResults(searchResults.map(p =>
        p.id === selectedProduct.id ? { ...p, preferredRepId: repId || null } : p
      ));
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `products/${selectedProduct.id}`);
    }
  };

  const handleManualPriceSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProduct || !manualRepId || !manualPrice) return;
    try {
      const parsedPrice = parseFloat(manualPrice);
      if (isNaN(parsedPrice) || parsedPrice <= 0) {
        alert("Please enter a valid positive dollar amount.");
        return;
      }
      const priceRef = doc(collection(db, "prices"));
      const pricePayload: PriceEntry = {
        id: priceRef.id,
        productId: selectedProduct.id,
        repId: manualRepId,
        price: parsedPrice,
        packSize: manualPack,
        effectiveDate: serverTimestamp(),
        createdAt: serverTimestamp(),
        createdBy: currentUserUid
      };
      await setDoc(priceRef, pricePayload);
      setManualPrice("");
      setManualSuccess(true);
      setTimeout(() => setManualSuccess(false), 3000);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, "prices_manual");
    }
  };

  // Deletes the product. If it has price history, ALSO cascade-deletes
  // those price entries — but only once acknowledgeCascade has been
  // explicitly checked (enforced by the disabled state on the confirm
  // button below, not just a UI suggestion). Mirrors RepDirectory's
  // handleDeleteRep: batch-delete the dependent price entries first, then
  // delete the product document itself. If the product has NO price
  // history, this is just a single clean delete — no batch needed.
  const handleDeleteProduct = async () => {
    if (!selectedProduct) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      if (productPriceHistory.length > 0) {
        const BATCH_SIZE = 500;
        for (let i = 0; i < productPriceHistory.length; i += BATCH_SIZE) {
          const batch = writeBatch(db);
          const chunk = productPriceHistory.slice(i, i + BATCH_SIZE);
          chunk.forEach(entry => batch.delete(doc(db, "prices", entry.id)));
          await batch.commit();
        }
      }

      await deleteDoc(doc(db, "products", selectedProduct.id));

      setSearchResults(searchResults.filter(p => p.id !== selectedProduct.id));
      setSelectedProductId("");
      setShowDeleteConfirm(false);
      setAcknowledgeCascade(false);
    } catch (err: any) {
      console.error("Delete product error:", err);
      setDeleteError(err.message || "Failed to delete product. Please try again.");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
      <div className="lg:col-span-4 bg-white rounded-md shadow-sm border border-slate-200 p-3 flex flex-col h-[550px]">
        <div className="mb-2">
          <h2 className="text-xs font-bold text-slate-800">Product Catalog</h2>
          <p className="text-[10px] text-slate-400 mt-0.5 leading-none">Search Chapel Downs inventory</p>
        </div>

        <div className="relative mb-2">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            className="w-full text-[11px] pl-8 pr-2 py-1.5 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 bg-slate-50/50"
            placeholder="Type product name to search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="flex-1 overflow-y-auto space-y-1 pr-1">
          {isSearching ? (
            <div className="py-8 text-center text-[11px] text-slate-400">Searching...</div>
          ) : !searchQuery.trim() ? (
            <div className="py-8 text-center text-[11px] text-slate-400">
              <Search className="h-6 w-6 mx-auto mb-2 text-slate-300" />
              Type a product name to search
            </div>
          ) : searchResults.length === 0 ? (
            <div className="py-8 text-center text-[11px] text-slate-400">
              No products found for "{searchQuery}"
            </div>
          ) : (
            searchResults.map(p => (
              <div
                key={p.id}
                onClick={() => handleSelectProduct(p.id)}
                className={`p-2 rounded border text-left cursor-pointer transition-all ${
                  selectedProductId === p.id
                    ? "border-emerald-500 bg-emerald-50/30 font-medium"
                    : "border-slate-100 hover:border-slate-250 hover:bg-slate-50/50"
                }`}
              >
                <div className="flex items-start justify-between gap-1 leading-tight">
                  <h3 className="text-[11px] font-semibold text-slate-800 line-clamp-1">{p.name}</h3>
                  {p.lowStock && <AlertTriangle className="h-3 w-3 text-rose-500 shrink-0 animate-pulse" />}
                </div>
                <div className="flex items-center justify-between mt-1 text-[9px] text-slate-400 font-mono">
                  <span>Code: {p.id}</span>
                  <span className="px-1 bg-slate-100 rounded text-slate-500 capitalize text-[8px]">{p.category || "General"}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="lg:col-span-8 space-y-3">
        {selectedProduct ? (
          <div ref={productDetailRef} className="bg-white rounded-md shadow-sm border border-slate-200 p-4 space-y-4 text-left">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-slate-150">
              <div>
                <span className="text-[9px] uppercase font-bold tracking-wider text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
                  {selectedProduct.category || "General"}
                </span>
                <h1 className="text-base font-bold text-slate-900 mt-1 leading-snug">{selectedProduct.name}</h1>
                <p className="text-[10px] font-mono text-slate-400 mt-0.5">POS SKU Barcode: {selectedProduct.id}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleToggleLowStock}
                  className={`px-2 py-1 text-[10px] font-semibold rounded flex items-center gap-1.5 cursor-pointer transition-all ${
                    selectedProduct.lowStock
                      ? "bg-amber-100 text-amber-900 border border-amber-200"
                      : "bg-slate-100 border border-slate-200 text-slate-700 hover:bg-slate-200"
                  }`}
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>{selectedProduct.lowStock ? "Low Stock: Active" : "Flag Low Stock"}</span>
                </button>
                <button
                  onClick={() => { setShowDeleteConfirm(true); setDeleteError(null); setAcknowledgeCascade(false); }}
                  className="px-2 py-1 bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 text-[10px] font-semibold rounded flex items-center gap-1.5 cursor-pointer transition-all"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Delete</span>
                </button>
              </div>
            </div>

            {/* DELETE CONFIRMATION — behavior branches on whether this
                product has any price history. No history: simple confirm.
                Has history: explicit cascade acknowledgment required
                before the delete button enables, same discipline
                RepDirectory uses for deleting a rep. */}
            {showDeleteConfirm && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded space-y-2.5">
                {productPriceHistory.length === 0 ? (
                  <>
                    <p className="text-[11px] font-bold text-rose-800">Delete "{selectedProduct.name}"?</p>
                    <p className="text-[10px] text-rose-700">This product has no price history on file. This cannot be undone.</p>
                  </>
                ) : (
                  <>
                    <p className="text-[11px] font-bold text-rose-800">Delete "{selectedProduct.name}"?</p>
                    <p className="text-[10px] text-rose-700">
                      This product has <strong>{productPriceHistory.length} price {productPriceHistory.length === 1 ? "entry" : "entries"}</strong> on file
                      {productPriceRepNames.length > 0 && <> from <strong>{productPriceRepNames.join(", ")}</strong></>}.
                      Deleting the product will <strong>also permanently delete this price history</strong> — it cannot be recovered. This cannot be undone.
                    </p>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={acknowledgeCascade}
                        onChange={(e) => setAcknowledgeCascade(e.target.checked)}
                        className="mt-0.5 cursor-pointer"
                      />
                      <span className="text-[10px] text-rose-800 font-semibold">
                        I understand this will delete {productPriceHistory.length} price {productPriceHistory.length === 1 ? "entry" : "entries"} too.
                      </span>
                    </label>
                  </>
                )}

                {deleteError && (
                  <div className="p-2 bg-rose-100 border border-rose-300 text-rose-900 text-[10px] rounded flex items-start gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{deleteError}</span>
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={handleDeleteProduct}
                    disabled={isDeleting || (productPriceHistory.length > 0 && !acknowledgeCascade)}
                    className="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 disabled:text-slate-500 text-white text-[10px] font-bold rounded cursor-pointer flex items-center gap-1"
                  >
                    {isDeleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                    <span>{isDeleting ? (productPriceHistory.length > 0 ? "Deleting price history..." : "Deleting...") : "Yes, Delete"}</span>
                  </button>
                  <button
                    onClick={() => { setShowDeleteConfirm(false); setAcknowledgeCascade(false); setDeleteError(null); }}
                    disabled={isDeleting}
                    className="px-2.5 py-1 border border-slate-200 hover:bg-slate-50 text-slate-600 text-[10px] rounded cursor-pointer disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* PRICING & MARGINS — sourced from the POS pricing import
                (POSImport.tsx, "Update Pricing & Margins" mode) OR from a
                manual inline edit below, which writes the exact same six
                fields together so the two paths never disagree. */}
            <div className="p-3 bg-slate-50 border border-slate-200 rounded space-y-2.5">
              <div className="flex items-center gap-1.5">
                <DollarSign className="h-4 w-4 text-emerald-600" />
                <h3 className="text-[11px] font-bold text-slate-800">Pricing &amp; Margins</h3>
                {!isEditingPricing && selectedProduct.pricingFlag === "LOSS_OR_BREAKEVEN" && (
                  <span className="flex items-center gap-1 text-[8px] font-bold text-rose-700 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded">
                    <AlertOctagon className="h-2.5 w-2.5" />
                    Loss / Break-even
                  </span>
                )}
                {!isEditingPricing && (
                  <button
                    onClick={handleStartEditPricing}
                    className="ml-auto p-1 px-2 bg-white hover:bg-slate-100 border border-slate-200 text-slate-600 rounded text-[9px] font-bold flex items-center gap-1 cursor-pointer"
                  >
                    <Edit2 className="h-2.5 w-2.5" />
                    <span>{hasPricingData ? "Edit" : "Add Pricing"}</span>
                  </button>
                )}
              </div>

              {isEditingPricing ? (
                <div className="space-y-2.5">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-0.5">
                      <label className="text-[8px] uppercase font-bold text-slate-400">Cost Price ($)</label>
                      <input
                        type="number" step="0.01" min="0" autoFocus
                        className="w-full text-[12px] font-bold font-mono bg-white border border-slate-300 p-1.5 rounded focus:outline-none focus:border-emerald-500"
                        placeholder="0.00"
                        value={pricingCostInput}
                        onChange={(e) => setPricingCostInput(e.target.value)}
                      />
                    </div>
                    <div className="space-y-0.5">
                      <label className="text-[8px] uppercase font-bold text-slate-400">Selling Price ($)</label>
                      <input
                        type="number" step="0.01" min="0"
                        className="w-full text-[12px] font-bold font-mono bg-white border border-slate-300 p-1.5 rounded focus:outline-none focus:border-emerald-500"
                        placeholder="0.00"
                        value={pricingSellingInput}
                        onChange={(e) => setPricingSellingInput(e.target.value)}
                      />
                    </div>
                  </div>

                  {pricingEditPreview ? (
                    <div className={`p-2 rounded border text-[10px] ${
                      pricingEditPreview.pricingFlag === "LOSS_OR_BREAKEVEN" ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-emerald-50 border-emerald-200 text-emerald-800"
                    }`}>
                      <span className="font-bold">Margin ${pricingEditPreview.margin.toFixed(2)}</span>
                      <span className="mx-1.5">·</span>
                      <span className="font-bold">GP {pricingEditPreview.gpPercent.toFixed(1)}%</span>
                      <span className="mx-1.5">·</span>
                      <span>Markup {pricingEditPreview.markupPercent.toFixed(1)}%</span>
                      {pricingEditPreview.pricingFlag === "LOSS_OR_BREAKEVEN" && (
                        <span className="ml-1.5 font-bold">— cost ≥ selling, will be flagged</span>
                      )}
                    </div>
                  ) : (
                    <p className="text-[9px] text-slate-400 italic">Enter a valid Cost Price and Selling Price (both above $0) to see the calculated margin.</p>
                  )}

                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setIsEditingPricing(false)}
                      disabled={isSavingPricing}
                      className="px-2.5 py-1 border border-slate-200 hover:bg-slate-50 text-slate-600 text-[10px] font-semibold rounded cursor-pointer flex items-center gap-1 disabled:opacity-50"
                    >
                      <X className="h-3 w-3" />
                      <span>Cancel</span>
                    </button>
                    <button
                      onClick={handleSavePricing}
                      disabled={isSavingPricing || !pricingEditPreview}
                      className="px-2.5 py-1 bg-emerald-700 hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-400 text-white text-[10px] font-bold rounded cursor-pointer flex items-center gap-1"
                    >
                      <Save className="h-3 w-3" />
                      <span>{isSavingPricing ? "Saving..." : "Save"}</span>
                    </button>
                  </div>
                </div>
              ) : !hasPricingData ? (
                <div className="py-3 text-center text-[10px] text-slate-400 italic">
                  No retail pricing data on file for this product — click "Add Pricing" above to set it manually, or run the pricing CSV import.
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="bg-white border border-slate-200 rounded p-2 text-center">
                      <p className="text-[8px] uppercase font-bold text-slate-400">Cost Price</p>
                      <p className="text-sm font-extrabold text-slate-800 font-mono mt-0.5">${selectedProduct.costPrice!.toFixed(2)}</p>
                    </div>
                    <div className="bg-white border border-slate-200 rounded p-2 text-center">
                      <p className="text-[8px] uppercase font-bold text-slate-400">Selling Price</p>
                      <p className="text-sm font-extrabold text-slate-900 font-mono mt-0.5">${selectedProduct.sellingPrice!.toFixed(2)}</p>
                    </div>
                    <div className={`border rounded p-2 text-center ${
                      selectedProduct.pricingFlag === "LOSS_OR_BREAKEVEN" ? "bg-rose-50 border-rose-200" : "bg-emerald-50 border-emerald-200"
                    }`}>
                      <p className="text-[8px] uppercase font-bold text-slate-400">Margin</p>
                      <p className={`text-sm font-extrabold font-mono mt-0.5 ${
                        selectedProduct.pricingFlag === "LOSS_OR_BREAKEVEN" ? "text-rose-700" : "text-emerald-700"
                      }`}>
                        ${selectedProduct.margin!.toFixed(2)}
                      </p>
                    </div>
                    <div className={`border rounded p-2 text-center ${
                      selectedProduct.pricingFlag === "LOSS_OR_BREAKEVEN" ? "bg-rose-50 border-rose-200" : "bg-emerald-50 border-emerald-200"
                    }`}>
                      <p className="text-[8px] uppercase font-bold text-slate-400">GP %</p>
                      <p className={`text-sm font-extrabold font-mono mt-0.5 ${
                        selectedProduct.pricingFlag === "LOSS_OR_BREAKEVEN" ? "text-rose-700" : "text-emerald-700"
                      }`}>
                        {selectedProduct.gpPercent!.toFixed(1)}%
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-1 px-0.5">
                    <span className="text-[9px] text-slate-400">
                      Markup: <span className="font-bold text-slate-600">{selectedProduct.markupPercent!.toFixed(1)}%</span>
                      <span className="text-slate-300 mx-1">·</span>
                      GP% = (Selling − Cost) ÷ Selling. Markup% = (Selling − Cost) ÷ Cost.
                    </span>
                  </div>
                </>
              )}

              {pricingSaveSuccess && (
                <div className="text-[9px] text-emerald-800 font-bold bg-emerald-50 border border-emerald-200 p-1 text-center rounded">
                  Pricing updated!
                </div>
              )}
            </div>

            <div className="p-3 bg-slate-50 border border-slate-200 rounded space-y-2.5">
              <div className="flex items-center gap-1.5">
                <Package className="h-4 w-4 text-emerald-600" />
                <h3 className="text-[11px] font-bold text-slate-800">Stock Control Levels</h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-0.5">
                  <label className="text-[8px] uppercase font-bold text-slate-400">Current On-Hand Stock</label>
                  <input
                    type="number" min="0"
                    className="w-full text-[10px] bg-white border border-slate-200 p-1.5 rounded focus:outline-none focus:border-emerald-500 font-mono"
                    placeholder="e.g. 15"
                    value={currentStockInput}
                    onChange={(e) => setCurrentStockInput(e.target.value)}
                  />
                </div>
                <div className="space-y-0.5">
                  <label className="text-[8px] uppercase font-bold text-slate-400">Minimum Stock Level</label>
                  <input
                    type="number" min="0"
                    className="w-full text-[10px] bg-white border border-slate-200 p-1.5 rounded focus:outline-none focus:border-emerald-500 font-mono"
                    placeholder="e.g. 10"
                    value={minStockInput}
                    onChange={(e) => setMinStockInput(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                <span className="text-[9px]">
                  {parseInt(currentStockInput) < parseInt(minStockInput) ? (
                    <span className="text-rose-700 font-bold flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3 animate-pulse" />
                      <span>Stock below threshold!</span>
                    </span>
                  ) : (
                    <span className="text-emerald-700 font-bold flex items-center gap-1">
                      <CheckCircle className="h-3 w-3" />
                      <span>Stock level compliant</span>
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={handleSaveStockLevels}
                  className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white text-[10px] font-bold rounded cursor-pointer transition-all"
                >
                  Save Stock Rules
                </button>
              </div>
              {stockSuccess && (
                <div className="text-[9px] text-emerald-800 font-bold bg-emerald-50 border border-emerald-200 p-1 text-center rounded">
                  Inventory levels saved!
                </div>
              )}
            </div>

            <div className="p-2.5 bg-amber-50/50 rounded border border-amber-100 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-start gap-1.5">
                <Bookmark className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <div>
                  <h3 className="text-[11px] font-bold text-amber-900">Preferred Representative</h3>
                  <p className="text-[9px] text-amber-700 leading-none">Default supplier for this product</p>
                </div>
              </div>
              <div className="sm:w-56">
                <select
                  className="w-full text-[10px] bg-white border border-slate-200 p-1.5 rounded text-amber-900 focus:outline-none"
                  value={selectedProduct.preferredRepId || ""}
                  onChange={(e) => handleUpdatePreferredRep(e.target.value)}
                >
                  <option value="">-- Set Preferred Rep --</option>
                  {reps.map(r => (
                    <option key={r.id} value={r.id}>{r.name} ({r.company})</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-[11px] font-bold text-slate-700 flex items-center gap-1">
                <Landmark className="h-3.5 w-3.5 text-emerald-600" />
                <span>Supplier Quote Comparison</span>
              </h3>
              {repCurrentPrices.length === 0 ? (
                <div className="py-6 bg-slate-50/50 border border-slate-100 rounded text-center text-[10px] text-slate-400">
                  No rep quotes logged yet. Upload a docket or log prices below.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {repCurrentPrices.map(entry => {
                    const matchedRep = reps.find(r => r.id === entry.repId);
                    const isCheapest = entry.repId === lowestPriceRepId;
                    const isPreferred = entry.repId === selectedProduct.preferredRepId;
                    const packQty = (entry as any).packQuantity;
                    const perUnit = getPerUnit(entry);
                    return (
                      <div
                        key={entry.id}
                        className={`p-2.5 rounded border relative flex flex-col justify-between ${
                          isCheapest ? "border-emerald-500 bg-emerald-50/10" : "border-slate-200 bg-white"
                        }`}
                      >
                        <div className="absolute top-2.5 right-2.5 flex gap-1 items-center">
                          {isPreferred && <Star className="h-2.5 w-2.5 fill-amber-500 text-amber-500" />}
                          {isCheapest && (
                            <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-800 text-[8px] font-bold rounded uppercase">
                              Cheapest
                            </span>
                          )}
                        </div>
                        <div>
                          <p className="text-[8px] font-mono text-slate-400 uppercase tracking-tight">
                            {matchedRep?.company || "Unknown"}
                          </p>
                          <h4 className="text-[11px] font-bold text-slate-800 mt-0.5">
                            {matchedRep?.name || "Unknown Rep"}
                          </h4>
                          <div className="flex items-baseline gap-0.5 mt-1.5">
                            <span className="text-[15px] font-extrabold text-slate-900">${entry.price.toFixed(2)}</span>
                            <span className="text-[9px] text-slate-400">
                              /{packQty ? `${packQty}-box` : (entry.packSize || "unit")}
                            </span>
                          </div>
                          {perUnit !== null ? (
                            <div className="flex items-center gap-2 mt-1 text-[9px]">
                              <span className="font-bold text-emerald-700">${perUnit.toFixed(2)}/unit</span>
                              <span className="text-slate-400">${(perUnit * 1.15).toFixed(2)}/unit +GST</span>
                            </div>
                          ) : entry.packSize ? (
                            <p className="text-[8px] text-slate-400 mt-1">{entry.packSize}</p>
                          ) : null}
                        </div>
                        <div className="mt-2 pt-1 border-t border-slate-100 text-[8px] text-slate-400">
                          Updated: {new Date(entry.effectiveDate?.seconds ? entry.effectiveDate.seconds * 1000 : entry.effectiveDate).toLocaleDateString()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-2 pt-2 border-t border-slate-150">
              <h3 className="text-[11px] font-bold text-slate-700 flex items-center gap-1">
                <History className="h-3.5 w-3.5 text-emerald-600" />
                <span>Price History (kept forever)</span>
              </h3>
              {productPriceHistory.length === 0 ? (
                <p className="text-[10px] text-slate-400 italic">No price history recorded yet.</p>
              ) : (
                <div className="space-y-1 max-h-36 overflow-y-auto pr-1">
                  {productPriceHistory.map(entry => {
                    const r = reps.find(rep => rep.id === entry.repId);
                    const packQty = (entry as any).packQuantity;
                    const perUnit = getPerUnit(entry);
                    return (
                      <div key={entry.id} className="flex items-center justify-between p-1.5 bg-slate-50 border border-slate-150 rounded text-[10px]">
                        <div className="space-y-0.5">
                          <p className="font-bold text-slate-700">{r ? `${r.name} (${r.company})` : "Manual Entry / Unlinked Rep"}</p>
                          <p className="text-[8px] text-slate-400">
                            {new Date(entry.createdAt?.seconds ? entry.createdAt.seconds * 1000 : entry.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-extrabold text-emerald-800">${entry.price.toFixed(2)}</p>
                          <p className="text-[8px] text-slate-400 font-mono">
                            {packQty ? `${packQty}/box` : (entry.packSize || "Single Unit")}
                          </p>
                          {perUnit !== null && (
                            <p className="text-[8px] text-amber-700 font-mono">
                              ${perUnit.toFixed(2)}/unit · ${(perUnit * 1.15).toFixed(2)} +GST
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <form onSubmit={handleManualPriceSave} className="p-3 bg-slate-50 border border-slate-200 rounded space-y-2.5">
              <div className="flex items-center gap-1">
                <PlusCircle className="h-4 w-4 text-emerald-700" />
                <h4 className="text-[11px] font-bold text-slate-800">Manually Log Representative Quote</h4>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="space-y-0.5">
                  <label className="text-[8px] uppercase font-bold text-slate-400">Supplier Rep</label>
                  <select
                    required
                    className="w-full text-[10px] bg-white border border-slate-200 p-1 rounded focus:outline-none focus:border-emerald-500"
                    value={manualRepId}
                    onChange={(e) => setManualRepId(e.target.value)}
                  >
                    <option value="">-- Choose Rep --</option>
                    {reps.map(r => <option key={r.id} value={r.id}>{r.name} ({r.company})</option>)}
                  </select>
                </div>
                <div className="space-y-0.5">
                  <label className="text-[8px] uppercase font-bold text-slate-400">Wholesale Price ($)</label>
                  <input
                    type="number" step="0.01" required
                    className="w-full text-[10px] bg-white border border-slate-200 p-1 rounded focus:outline-none focus:border-emerald-500 font-mono"
                    placeholder="e.g. 3.45"
                    value={manualPrice}
                    onChange={(e) => setManualPrice(e.target.value)}
                  />
                </div>
                <div className="space-y-0.5">
                  <label className="text-[8px] uppercase font-bold text-slate-400">Pack / Box Size</label>
                  <input
                    type="text"
                    className="w-full text-[10px] bg-white border border-slate-200 p-1 rounded focus:outline-none focus:border-emerald-500"
                    placeholder="e.g. Box of 24"
                    value={manualPack}
                    onChange={(e) => setManualPack(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                {manualSuccess ? (
                  <div className="flex items-center gap-1 text-emerald-700 text-[10px] font-semibold">
                    <CheckCircle className="h-3.5 w-3.5" />
                    <span>Price logged!</span>
                  </div>
                ) : <div></div>}
                <button
                  type="submit"
                  className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white text-[10px] font-semibold rounded cursor-pointer transition-all"
                >
                  Log Price Entry
                </button>
              </div>
            </form>
          </div>
        ) : (
          <div className="bg-white rounded-md shadow-sm border border-slate-200 p-12 text-center text-slate-400 flex flex-col items-center justify-center h-[550px]">
            <Search className="h-8 w-8 text-slate-300 mb-2" />
            <h3 className="text-xs font-bold text-slate-700">Search for a Product</h3>
            <p className="text-[10px] text-slate-400 mt-1 max-w-xs leading-normal">
              Type a product name in the search box to find it and view supplier prices.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}