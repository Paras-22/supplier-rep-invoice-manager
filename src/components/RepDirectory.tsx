import React, { useState, useMemo, useEffect, useRef } from "react";
import { Users as UsersIcon, Phone as PhoneIcon, Mail as MailIcon, Calendar as CalendarIcon, PlusCircle as PlusIcon, CheckCircle as CheckIcon, Calculator as CalcIcon, AlertTriangle as AlertIcon, FileSpreadsheet as SheetIcon, Copy as CopyIcon, Printer as PrinterIcon, Loader2 as LoaderIcon, AlertCircle as AlertCircleIcon, Edit2, Trash2, Save, X, Search, TrendingUp, TrendingDown, Minus, FileText, Package, History as HistoryIcon } from "lucide-react";
import { collection, doc, setDoc, getDocs, getDoc, updateDoc, deleteDoc, serverTimestamp, query, where, writeBatch, arrayUnion } from "firebase/firestore";
import { db, handleFirestoreError, OperationType } from "../firebase";
import { Rep, Visit, Product, PriceEntry, Invoice } from "../types";
import { motion } from "motion/react";

interface RepDirectoryProps {
  reps: Rep[];
  visits: Visit[];
  products: Product[];
  priceEntries: PriceEntry[];
  invoices: Invoice[];
  onRepChange: () => void;
  currentUserUid: string;
  selectedRepId: string;
  setSelectedRepId: (value: string) => void;
  activeTab: "products" | "visits" | "notepad" | "order";
  setActiveTab: (value: "products" | "visits" | "notepad" | "order") => void;
  repProductSearch: string;
  setRepProductSearch: (value: string) => void;
  expandedProductId: string | null;
  setExpandedProductId: (value: string | null) => void;
}

// Shape of the in-progress edit form for a single price entry. Unit Price,
// Disc%, and Units/Box are independently editable — none of them
// auto-overwrite each other on save. Box Price is INTENTIONALLY NOT part
// of this form anymore — it's a computed, read-only value derived live as
// Unit Price × (1 − Disc%/100), same formula used by the docket scanner.
// This was previously a fourth independently-editable field, but allowing
// Box Price to be set to a number that didn't match Unit Price × Disc%
// created confusing, inconsistent entries — so it's now always trustworthy
// and derived, never manually overridden.
interface PriceEditForm {
  priceEntryId: string;
  productName: string;
  unitPrice: string;
  discPercent: string;
  packQuantity: string;
}

// One snapshot of a price entry's values right before a correction was
// saved. Stored append-only on the price entry's editHistory array so the
// old value is never lost — only the current displayed values change.
interface PriceEditHistoryItem {
  editedAt: string;
  previousUnitPrice: number | null;
  previousDiscPercent: number | null;
  previousBoxPrice: number;
  previousPackQuantity: number | null;
}

export default function RepDirectory({
  reps,
  visits,
  products,
  priceEntries,
  invoices,
  onRepChange,
  currentUserUid,
  selectedRepId,
  setSelectedRepId,
  activeTab,
  setActiveTab,
  repProductSearch,
  setRepProductSearch,
  expandedProductId,
  setExpandedProductId
}: RepDirectoryProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [copiedOrder, setCopiedOrder] = useState(false);
  const [showPrintReport, setShowPrintReport] = useState(false);
  // Delete-price-entry state: tracks which product row has its delete
  // confirmation open, and whether a delete is currently in flight.
  const [confirmDeletePriceId, setConfirmDeletePriceId] = useState<string | null>(null);
  const [isDeletingPrice, setIsDeletingPrice] = useState(false);
  // Edit-price-entry state: holds the in-progress edit form when a row's
  // edit modal is open, plus saving/error state for that save action.
  const [editingPrice, setEditingPrice] = useState<PriceEditForm | null>(null);
  const [isSavingPriceEdit, setIsSavingPriceEdit] = useState(false);
  const [priceEditError, setPriceEditError] = useState<string | null>(null);
  // Add rep state
  const [newName, setNewName] = useState("");
  const [newCompany, setNewCompany] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [profileSuccess, setProfileSuccess] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Edit rep state
  const [showEditForm, setShowEditForm] = useState(false);
  const [editName, setEditName] = useState("");
  const [editCompany, setEditCompany] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [isEditing, setIsEditing] = useState(false);

  // Delete rep state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Visit state
  const [visitText, setVisitText] = useState("");
  const [visitSuccess, setVisitSuccess] = useState(false);

  // Notepad state
  const [notepadText, setNotepadText] = useState("");
  const [notepadSaving, setNotepadSaving] = useState(false);
  const [notepadSaved, setNotepadSaved] = useState(false);
  const [notepadLoaded, setNotepadLoaded] = useState(false);

  // Order state
  const [orderQtys, setOrderQtys] = useState<{ [prodId: string]: number }>({});

  // Reference to the rep detail panel container. When a rep is tapped on
  // mobile, the scroll position otherwise stays exactly where it was —
  // often still showing the rep LIST — leaving no visual cue that
  // anything happened until the user manually scrolls down. This ref lets
  // us smooth-scroll the detail panel into view right after selection.
  const repDetailRef = useRef<HTMLDivElement>(null);

  const selectedRep = useMemo(() => reps.find(r => r.id === selectedRepId) || null, [reps, selectedRepId]);

  // Load notepad when rep changes
  useEffect(() => {
    if (!selectedRepId) return;
    setNotepadLoaded(false);
    setNotepadText("");

    const loadNotepad = async () => {
      try {
        const snap = await getDocs(collection(db, "reps", selectedRepId, "notepad"));
        if (!snap.empty) {
          const data = snap.docs[0].data();
          setNotepadText(data.content || "");
        }
        setNotepadLoaded(true);
      } catch {
        setNotepadLoaded(true);
      }
    };
    loadNotepad();
  }, [selectedRepId]);

  // Populate edit form when rep selected
  useEffect(() => {
    if (selectedRep) {
      setEditName(selectedRep.name);
      setEditCompany(selectedRep.company);
      setEditEmail(selectedRep.email || "");
      setEditPhone(selectedRep.phone || "");
      setEditNotes(selectedRep.notes || "");
    }
  }, [selectedRep]);

  const repVisits = useMemo(() => {
    if (!selectedRepId) return [];
    return visits
      .filter(v => v.repId === selectedRepId)
      .sort((a, b) => {
        const timeA = a.visitDate?.seconds || new Date(a.visitDate).getTime() / 1000;
        const timeB = b.visitDate?.seconds || new Date(b.visitDate).getTime() / 1000;
        return timeB - timeA;
      });
  }, [visits, selectedRepId]);

  const repSuppliedProductIds = useMemo(() => {
    if (!selectedRepId) return [];
    const ids = new Set<string>();
    priceEntries.forEach(entry => {
      if (entry.repId === selectedRepId) ids.add(entry.productId);
    });
    return Array.from(ids);
  }, [priceEntries, selectedRepId]);

  const suppliedProducts = useMemo(() => {
    return products.filter(p => repSuppliedProductIds.includes(p.id));
  }, [products, repSuppliedProductIds]);

  const filteredSuppliedProducts = useMemo(() => {
    if (!repProductSearch.trim()) return suppliedProducts;
    const q = repProductSearch.toLowerCase();
    return suppliedProducts.filter(p => p.name.toLowerCase().includes(q));
  }, [suppliedProducts, repProductSearch]);

  // Get current and previous prices per product for this rep.
  // packQuantity, unitPrice, and discPercent are passed through exactly as
  // extracted/computed in DocketScanner.tsx, OR as subsequently corrected
  // via the edit modal — no calculation happens in this memo itself.
  // Also exposes the latest entry's own document id (latestEntryId) and
  // editHistory so the per-row edit/delete buttons and the audit-trail
  // expand row know exactly which Firestore doc to touch and what past
  // corrections (if any) to display.
  const productPriceData = useMemo(() => {
    const data: { [productId: string]: { current: number; previous: number | null; change: number | null; changePct: number | null; packQuantity: number | null; unitPrice: number | null; discPercent: number | null; effectiveDate: any; latestEntryId: string; editHistory: PriceEditHistoryItem[] } } = {};

    repSuppliedProductIds.forEach(productId => {
      const entries = priceEntries
        .filter(e => e.repId === selectedRepId && e.productId === productId)
        .sort((a, b) => {
          const timeA = a.effectiveDate?.seconds ? a.effectiveDate.seconds * 1000 : new Date(a.effectiveDate).getTime();
          const timeB = b.effectiveDate?.seconds ? b.effectiveDate.seconds * 1000 : new Date(b.effectiveDate).getTime();
          return timeB - timeA;
        });

      if (entries.length === 0) return;

      const current = entries[0].price;
      const previous = entries.length > 1 ? entries[1].price : null;
      const change = previous !== null ? current - previous : null;
      const changePct = previous !== null && previous > 0 ? ((current - previous) / previous) * 100 : null;
      const packQuantity = entries[0].packQuantity ?? null;
      const unitPrice = (entries[0] as any).unitPrice ?? null;
      const discPercent = (entries[0] as any).discPercent ?? null;
      const effectiveDate = entries[0].effectiveDate;
      const latestEntryId = entries[0].id;
      const editHistory: PriceEditHistoryItem[] = (entries[0] as any).editHistory ?? [];

      data[productId] = { current, previous, change, changePct, packQuantity, unitPrice, discPercent, effectiveDate, latestEntryId, editHistory };
    });

    return data;
  }, [priceEntries, selectedRepId, repSuppliedProductIds]);

  const lowStockSuppliedProducts = useMemo(() => suppliedProducts.filter(p => p.lowStock), [suppliedProducts]);

  const weeklyExpenseSummary = useMemo(() => {
    if (!selectedRepId) return { currentWeekTotal: 0, lifetimeSpent: 0 };
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    let currentWeekTotal = 0;
    let lifetimeSpent = 0;
    invoices.forEach(inv => {
      if (inv.repId === selectedRepId && inv.status === "confirmed") {
        const value = inv.totalAmount || 0;
        lifetimeSpent += value;
        const invDateObj = new Date(inv.invoiceDate || inv.createdAt);
        if (invDateObj >= sevenDaysAgo) currentWeekTotal += value;
      }
    });
    return { currentWeekTotal, lifetimeSpent };
  }, [invoices, selectedRepId]);

  // NOTE: this still computes unitPrice/lineCost/totalCost internally —
  // that's used for the in-app "Estimated Total" display in the Order
  // Draft tab, which the manager DOES want to see for themselves. Only the
  // text that gets copied/printed to share with someone else strips this
  // out (see handleCopyOrderText and handlePrintPurchaseOrder below).
  const draftOrderSummary = useMemo(() => {
    let totals = 0;
    const itemsList: { name: string; qty: number; unitPrice: number; lineCost: number }[] = [];
    Object.entries(orderQtys).forEach(([prodId, qty]) => {
      if (qty <= 0) return;
      const prod = suppliedProducts.find(p => p.id === prodId);
      const price = productPriceData[prodId]?.current || 0;
      if (prod) {
        const lineCost = price * qty;
        totals += lineCost;
        itemsList.push({ name: prod.name, qty, unitPrice: price, lineCost });
      }
    });
    return { totalCost: totals, items: itemsList };
  }, [orderQtys, suppliedProducts, productPriceData]);

  // ── HANDLERS ──────────────────────────────────────────────────────────

  // Selects a rep and smooth-scrolls the detail panel into view. The small
  // delay lets selectedRep (which depends on selectedRepId) actually update
  // and render before we try to scroll to its container.
  const handleSelectRep = (repId: string) => {
    setSelectedRepId(repId);
    setShowEditForm(false);
    setShowDeleteConfirm(false);
    setActiveTab("products");
    setTimeout(() => {
      repDetailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  };

  const handleCreateRep = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newCompany.trim()) return;
    setIsSubmitting(true);
    setProfileError(null);
    try {
      const repRef = doc(collection(db, "reps"));
      const newRep: Rep = {
        id: repRef.id,
        name: newName.trim(),
        company: newCompany.trim(),
        createdAt: serverTimestamp()
      };
      if (newEmail.trim()) newRep.email = newEmail.trim();
      if (newPhone.trim()) newRep.phone = newPhone.trim();
      if (newNotes.trim()) newRep.notes = newNotes.trim();
      await setDoc(repRef, newRep);
      setNewName(""); setNewCompany(""); setNewEmail(""); setNewPhone(""); setNewNotes("");
      setProfileSuccess(true);
      setTimeout(() => { setProfileSuccess(false); setShowAddForm(false); }, 1500);
      onRepChange();
    } catch (err: any) {
      let errMsg = err.message || "Error saving profile.";
      if (errMsg.includes("permission") || errMsg.includes("insufficient")) errMsg = "Permission Denied.";
      setProfileError(errMsg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEditRep = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRepId || !editName.trim() || !editCompany.trim()) return;
    setIsEditing(true);
    try {
      await updateDoc(doc(db, "reps", selectedRepId), {
        name: editName.trim(),
        company: editCompany.trim(),
        email: editEmail.trim() || null,
        phone: editPhone.trim() || null,
        notes: editNotes.trim() || null,
      });
      setShowEditForm(false);
      onRepChange();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `reps/${selectedRepId}`);
    } finally {
      setIsEditing(false);
    }
  };

  // Deletes a rep AND all of their associated price history. Previously this
  // only deleted the rep document, leaving every priceEntry pointing at a
  // now-nonexistent repId — these orphans showed up as "Unknown Rep" in
  // ProductCatalog and made testing/re-scanning impossible to clean up
  // without a manual Firestore script. This now cascades properly.
  const handleDeleteRep = async () => {
    if (!selectedRepId) return;
    setIsDeleting(true);
    try {
      const pricesQuery = query(collection(db, "prices"), where("repId", "==", selectedRepId));
      const pricesSnap = await getDocs(pricesQuery);

      if (!pricesSnap.empty) {
        const BATCH_SIZE = 500;
        const docs = pricesSnap.docs;
        for (let i = 0; i < docs.length; i += BATCH_SIZE) {
          const batch = writeBatch(db);
          const chunk = docs.slice(i, i + BATCH_SIZE);
          chunk.forEach(d => batch.delete(doc(db, "prices", d.id)));
          await batch.commit();
        }
      }

      await deleteDoc(doc(db, "reps", selectedRepId));
      setSelectedRepId("");
      setShowDeleteConfirm(false);
      onRepChange();
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `reps/${selectedRepId}`);
    } finally {
      setIsDeleting(false);
    }
  };

  // Deletes a single price history entry (the latest one shown for a
  // product under this rep) without touching the rep profile or any other
  // price entries. Used to remove a single bad/duplicate scan.
  const handleDeletePriceEntry = async (priceEntryId: string) => {
    setIsDeletingPrice(true);
    try {
      await deleteDoc(doc(db, "prices", priceEntryId));
      setConfirmDeletePriceId(null);
      onRepChange();
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `prices/${priceEntryId}`);
    } finally {
      setIsDeletingPrice(false);
    }
  };

  // Opens the edit modal for a given product's latest price entry,
  // pre-filling the form with its current values. Box Price is no longer
  // part of this form — it's shown live in the preview below, computed
  // from whatever Unit Price / Disc% the form currently holds.
  const handleOpenPriceEdit = (productName: string, pd: { latestEntryId: string; unitPrice: number | null; discPercent: number | null; current: number; packQuantity: number | null }) => {
    setPriceEditError(null);
    setEditingPrice({
      priceEntryId: pd.latestEntryId,
      productName,
      unitPrice: pd.unitPrice != null ? pd.unitPrice.toString() : pd.current.toString(),
      discPercent: pd.discPercent != null ? pd.discPercent.toString() : "0",
      packQuantity: pd.packQuantity != null ? pd.packQuantity.toString() : "1"
    });
  };

  // Saves Unit Price, Disc%, and Units/Box directly to Firestore. Box
  // Price is no longer independently editable — it's ALWAYS computed here
  // as Unit Price × (1 − Disc%/100), the same formula DocketScanner.tsx
  // uses on initial scan. This guarantees Box Price can never drift out of
  // sync with the Unit Price/Disc% it's supposed to represent.
  //
  // Before overwriting, this reads the document's CURRENT values and
  // appends them (with a timestamp) to editHistory via arrayUnion — so the
  // old value is never lost, only ever added to.
  const handleSavePriceEdit = async () => {
    if (!editingPrice) return;

    const parsedUnitPrice = parseFloat(editingPrice.unitPrice);
    const parsedDiscPercent = parseFloat(editingPrice.discPercent);
    const parsedPackQuantity = parseInt(editingPrice.packQuantity);

    if (isNaN(parsedUnitPrice) || parsedUnitPrice < 0) {
      setPriceEditError("Unit Price must be a valid non-negative number.");
      return;
    }
    if (isNaN(parsedDiscPercent) || parsedDiscPercent < 0 || parsedDiscPercent > 100) {
      setPriceEditError("Disc% must be between 0 and 100.");
      return;
    }
    if (isNaN(parsedPackQuantity) || parsedPackQuantity < 1) {
      setPriceEditError("Units/Box must be a whole number of at least 1.");
      return;
    }

    const computedBoxPrice = Math.round(parsedUnitPrice * (1 - parsedDiscPercent / 100) * 100) / 100;

    setIsSavingPriceEdit(true);
    setPriceEditError(null);
    try {
      const priceDocRef = doc(db, "prices", editingPrice.priceEntryId);

      // Snapshot the CURRENT (pre-edit) values before overwriting them.
      const currentSnap = await getDoc(priceDocRef);
      const currentData = currentSnap.exists() ? currentSnap.data() : null;

      const updatePayload: any = {
        price: computedBoxPrice,
        packQuantity: parsedPackQuantity,
        unitPrice: parsedUnitPrice,
        discPercent: parsedDiscPercent
      };

      // Only record history if something actually changed — avoids logging
      // a no-op "edit" if the manager opened the modal and saved without
      // changing anything.
      if (currentData) {
        const priorBoxPrice = currentData.price;
        const priorPackQuantity = currentData.packQuantity ?? null;
        const priorUnitPrice = currentData.unitPrice ?? null;
        const priorDiscPercent = currentData.discPercent ?? null;

        const somethingChanged =
          priorBoxPrice !== computedBoxPrice ||
          priorPackQuantity !== parsedPackQuantity ||
          priorUnitPrice !== parsedUnitPrice ||
          priorDiscPercent !== parsedDiscPercent;

        if (somethingChanged) {
          const historyItem: PriceEditHistoryItem = {
            editedAt: new Date().toISOString(),
            previousUnitPrice: priorUnitPrice,
            previousDiscPercent: priorDiscPercent,
            previousBoxPrice: priorBoxPrice,
            previousPackQuantity: priorPackQuantity
          };
          updatePayload.editHistory = arrayUnion(historyItem);
        }
      }

      await updateDoc(priceDocRef, updatePayload);
      setEditingPrice(null);
      onRepChange();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `prices/${editingPrice.priceEntryId}`);
      setPriceEditError("Failed to save changes. Please try again.");
    } finally {
      setIsSavingPriceEdit(false);
    }
  };

  const handleAddVisitLog = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRepId || !visitText.trim()) return;
    try {
      const visitRef = doc(collection(db, "reps", selectedRepId, "visits"));
      await setDoc(visitRef, {
        id: visitRef.id,
        repId: selectedRepId,
        visitDate: serverTimestamp(),
        notes: visitText,
        createdAt: serverTimestamp(),
        createdBy: currentUserUid
      });
      setVisitText("");
      setVisitSuccess(true);
      setTimeout(() => setVisitSuccess(false), 2000);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `reps/${selectedRepId}/visits`);
    }
  };

  const handleSaveNotepad = async () => {
    if (!selectedRepId) return;
    setNotepadSaving(true);
    try {
      const snap = await getDocs(collection(db, "reps", selectedRepId, "notepad"));
      if (snap.empty) {
        const noteRef = doc(collection(db, "reps", selectedRepId, "notepad"));
        await setDoc(noteRef, {
          id: noteRef.id,
          content: notepadText,
          updatedAt: serverTimestamp()
        });
      } else {
        await updateDoc(doc(db, "reps", selectedRepId, "notepad", snap.docs[0].id), {
          content: notepadText,
          updatedAt: serverTimestamp()
        });
      }
      setNotepadSaved(true);
      setTimeout(() => setNotepadSaved(false), 2000);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `reps/${selectedRepId}/notepad`);
    } finally {
      setNotepadSaving(false);
    }
  };

  const handlePrintNotepad = () => {
    if (!selectedRep) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;
    printWindow.document.write(`
      <html><head><title>Order Notes — ${selectedRep.name}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; color: #000; }
        h1 { font-size: 18px; border-bottom: 2px solid #000; padding-bottom: 8px; }
        h2 { font-size: 13px; color: #555; margin-top: 4px; }
        .meta { font-size: 11px; color: #777; margin-top: 16px; }
        .notes { font-size: 13px; line-height: 1.8; margin-top: 24px; white-space: pre-wrap; }
        .footer { margin-top: 48px; border-top: 1px dashed #ccc; padding-top: 16px; font-size: 10px; color: #aaa; }
      </style></head>
      <body>
        <h1>CHAPEL DOWNS SUPERMARKET</h1>
        <h2>Order Notes — ${selectedRep.name} (${selectedRep.company})</h2>
        <div class="meta">
          Phone: ${selectedRep.phone || "N/A"} &nbsp;|&nbsp; Email: ${selectedRep.email || "N/A"}<br/>
          Printed: ${new Date().toLocaleString()}
        </div>
        <div class="notes">${notepadText.replace(/\n/g, "<br/>")}</div>
        <div class="footer">Chapel Downs Supermarket — Supplier Rep & Invoice Manager</div>
      </body></html>
    `);
    printWindow.document.close();
    printWindow.print();
  };

  // Builds a plain-text purchase order with PRODUCT / QTY (BOXES) columns
  // only — no unit prices, no line costs, no grand total. This text is
  // meant to be shared externally (e.g. pasted to a rep via WhatsApp), and
  // wholesale cost data should never leave the business this way.
  const handleCopyOrderText = () => {
    if (!selectedRep || draftOrderSummary.items.length === 0) return;
    let output = `--- CHAPEL DOWNS SUPERMARKET - PURCHASE ORDER ---\n`;
    output += `Rep: ${selectedRep.name} | Company: ${selectedRep.company}\n`;
    output += `Date: ${new Date().toLocaleDateString()}\n`;
    output += `--------------------------------------------------\n`;
    output += `PRODUCT                          QTY (BOXES)\n`;
    output += `--------------------------------------------------\n`;
    draftOrderSummary.items.forEach((item, idx) => {
      output += `${idx + 1}. ${item.name} x${item.qty}\n`;
    });
    output += `--------------------------------------------------\n`;
    navigator.clipboard.writeText(output);
    setCopiedOrder(true);
    setTimeout(() => setCopiedOrder(false), 3000);
  };

  // Prints a clean purchase order page — same visual style as the existing
  // Notepad print and Supplier Briefing Report (Chapel Downs header banner,
  // simple table). Only Product name and Qty (Boxes) are shown — no
  // wholesale prices, since this is meant to be handed/shown to a rep.
  const handlePrintPurchaseOrder = () => {
    if (!selectedRep || draftOrderSummary.items.length === 0) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;
    const rowsHtml = draftOrderSummary.items.map((item, idx) => `
      <tr>
        <td class="idx">${idx + 1}</td>
        <td class="name">${item.name}</td>
        <td class="qty">${item.qty}</td>
      </tr>
    `).join("");
    printWindow.document.write(`
      <html><head><title>Purchase Order — ${selectedRep.name}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; color: #000; }
        h1 { font-size: 18px; border-bottom: 2px solid #000; padding-bottom: 8px; }
        h2 { font-size: 13px; color: #555; margin-top: 4px; }
        .meta { font-size: 11px; color: #777; margin-top: 16px; margin-bottom: 24px; }
        table { width: 100%; border-collapse: collapse; margin-top: 12px; }
        th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #666; border-bottom: 2px solid #333; padding: 8px 6px; }
        th.qty { text-align: right; }
        td { font-size: 13px; padding: 8px 6px; border-bottom: 1px solid #eee; }
        td.idx { color: #999; width: 30px; }
        td.qty { text-align: right; font-weight: bold; }
        .footer { margin-top: 48px; border-top: 1px dashed #ccc; padding-top: 16px; font-size: 10px; color: #aaa; }
      </style></head>
      <body>
        <h1>CHAPEL DOWNS SUPERMARKET</h1>
        <h2>Purchase Order — ${selectedRep.name} (${selectedRep.company})</h2>
        <div class="meta">Date: ${new Date().toLocaleDateString()}</div>
        <table>
          <thead>
            <tr><th>#</th><th>Product</th><th class="qty">Qty (Boxes)</th></tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div class="footer">Chapel Downs Supermarket — Supplier Rep & Invoice Manager</div>
      </body></html>
    `);
    printWindow.document.close();
    printWindow.print();
  };

  const priceChangeIcon = (change: number | null) => {
    if (change === null) return <Minus className="h-3 w-3 text-slate-400" />;
    if (change > 0) return <TrendingUp className="h-3 w-3 text-rose-500" />;
    if (change < 0) return <TrendingDown className="h-3 w-3 text-emerald-500" />;
    return <Minus className="h-3 w-3 text-slate-400" />;
  };

  const priceChangeLabel = (change: number | null, pct: number | null) => {
    if (change === null) return <span className="text-slate-400 text-[8px]">No history</span>;
    if (change === 0) return <span className="text-slate-400 text-[8px]">No change</span>;
    const color = change > 0 ? "text-rose-600 bg-rose-50" : "text-emerald-600 bg-emerald-50";
    return (
      <span className={`text-[8px] font-bold px-1 py-0.5 rounded ${color}`}>
        {change > 0 ? "+" : ""}${change.toFixed(2)} ({pct?.toFixed(1)}%)
      </span>
    );
  };

  // Live preview of Box Price / Per Unit / Per Unit (+GST) inside the edit
  // modal, computed from whatever Unit Price, Disc%, and Units/Box the form
  // currently holds. Box Price is no longer a separate input — this IS the
  // value that gets saved on submit, shown here so the manager can see it
  // before confirming.
  const editPreview = useMemo(() => {
    if (!editingPrice) return null;
    const unitPrice = parseFloat(editingPrice.unitPrice);
    const discPercent = parseFloat(editingPrice.discPercent);
    const pack = parseInt(editingPrice.packQuantity);
    if (isNaN(unitPrice) || isNaN(discPercent) || isNaN(pack) || pack <= 0) return null;
    const boxPrice = unitPrice * (1 - discPercent / 100);
    const perUnit = boxPrice / pack;
    return { boxPrice, perUnit, perUnitGst: perUnit * 1.15 };
  }, [editingPrice]);

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">

        {/* LEFT — REP LIST */}
        <div className="lg:col-span-4 bg-white rounded-md shadow-sm border border-slate-200 p-3 flex flex-col h-[600px]">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h2 className="text-xs font-bold text-slate-800">Supplier Representatives</h2>
              <p className="text-[10px] text-slate-400 mt-0.5 leading-none">{reps.length} reps — Chapel Downs</p>
            </div>
            <button
              onClick={() => { setShowAddForm(!showAddForm); setShowEditForm(false); }}
              className="p-1 px-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 rounded text-[10px] font-semibold flex items-center gap-1 cursor-pointer border border-emerald-200"
            >
              <PlusIcon className="h-3 w-3" />
              <span>New Rep</span>
            </button>
          </div>

          {showAddForm ? (
            <form onSubmit={handleCreateRep} className="space-y-2 bg-slate-50 border border-slate-200 rounded p-2.5 text-left overflow-y-auto">
              <h3 className="text-[10px] font-bold text-slate-700">Add New Rep</h3>
              {profileError && (
                <div className="p-2 bg-rose-50 text-rose-800 border border-rose-200 rounded text-[9px] flex items-center gap-1.5">
                  <AlertCircleIcon className="h-3.5 w-3.5 shrink-0 text-rose-600" />
                  <span>{profileError}</span>
                </div>
              )}
              {[
                { label: "Rep Name *", value: newName, setter: setNewName, placeholder: "e.g. Bhavesh", required: true },
                { label: "Company *", value: newCompany, setter: setNewCompany, placeholder: "e.g. Nalsun Imports", required: true },
                { label: "Phone", value: newPhone, setter: setNewPhone, placeholder: "+64 21 000 000", required: false },
                { label: "Email", value: newEmail, setter: setNewEmail, placeholder: "rep@company.co.nz", required: false },
              ].map(f => (
                <div key={f.label} className="space-y-0.5">
                  <label className="text-[8px] uppercase font-bold text-slate-400">{f.label}</label>
                  <input type="text" required={f.required} disabled={isSubmitting} className="w-full text-[10px] p-1 bg-white border border-slate-200 rounded focus:outline-none focus:border-emerald-500 disabled:opacity-50" placeholder={f.placeholder} value={f.value} onChange={(e) => f.setter(e.target.value)} />
                </div>
              ))}
              <div className="space-y-0.5">
                <label className="text-[8px] uppercase font-bold text-slate-400">Notes</label>
                <textarea rows={2} disabled={isSubmitting} className="w-full text-[10px] p-1 bg-white border border-slate-200 rounded focus:outline-none focus:border-emerald-500 disabled:opacity-50" placeholder="Min order $250, visits Tuesdays..." value={newNotes} onChange={(e) => setNewNotes(e.target.value)} />
              </div>
              <div className="flex justify-end gap-1.5 pt-1">
                <button type="button" disabled={isSubmitting} onClick={() => { setShowAddForm(false); setProfileError(null); }} className="text-[9px] font-bold text-slate-400 px-1.5 py-1 cursor-pointer">Cancel</button>
                <button type="submit" disabled={isSubmitting} className="bg-emerald-700 hover:bg-emerald-800 text-white text-[9px] font-bold px-2 py-1 rounded cursor-pointer disabled:opacity-50 flex items-center gap-1">
                  {isSubmitting && <LoaderIcon className="h-3 w-3 animate-spin" />}
                  <span>{profileSuccess ? "Saved!" : isSubmitting ? "Saving..." : "Save Rep"}</span>
                </button>
              </div>
            </form>
          ) : (
            <div className="flex-1 overflow-y-auto space-y-1 pr-1">
              {reps.length === 0 ? (
                <div className="py-8 text-center text-[11px] text-slate-400">No reps yet. Add one above.</div>
              ) : (
                reps.map(r => {
                  const repPriceCount = priceEntries.filter(e => e.repId === r.id).length;
                  return (
                    <div
                      key={r.id}
                      onClick={() => handleSelectRep(r.id)}
                      className={`p-2 rounded border text-left cursor-pointer transition-all ${selectedRepId === r.id ? "border-emerald-500 bg-emerald-50/30" : "border-slate-100 hover:border-slate-250 hover:bg-slate-50/50"}`}
                    >
                      <p className="text-[8px] font-mono text-slate-400 uppercase tracking-tight">{r.company}</p>
                      <h3 className="text-[11px] font-bold text-slate-800 mt-0.5">{r.name}</h3>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-[9px] text-slate-500 flex items-center gap-1">
                          <PhoneIcon className="h-3 w-3 text-slate-400" />
                          {r.phone || "No phone"}
                        </span>
                        {repPriceCount > 0 && (
                          <span className="text-[8px] bg-emerald-50 text-emerald-700 px-1 rounded font-bold">
                            {new Set(priceEntries.filter(e => e.repId === r.id).map(e => e.productId)).size} products
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* RIGHT — REP DETAIL */}
        <div className="lg:col-span-8 space-y-3">
          {selectedRep ? (
            <div ref={repDetailRef} className="bg-white rounded-md shadow-sm border border-slate-200 p-4 space-y-4 text-left">

              {/* PROFILE HEADER */}
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 pb-3 border-b border-slate-200">
                <div className="space-y-1 flex-1">
                  {showEditForm ? (
                    <form onSubmit={handleEditRep} className="space-y-2">
                      <h3 className="text-[10px] font-bold text-slate-700">Edit Rep Details</h3>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { label: "Name", value: editName, setter: setEditName },
                          { label: "Company", value: editCompany, setter: setEditCompany },
                          { label: "Phone", value: editPhone, setter: setEditPhone },
                          { label: "Email", value: editEmail, setter: setEditEmail },
                        ].map(f => (
                          <div key={f.label} className="space-y-0.5">
                            <label className="text-[8px] uppercase font-bold text-slate-400">{f.label}</label>
                            <input type="text" className="w-full text-[10px] p-1 bg-white border border-slate-200 rounded focus:outline-none focus:border-emerald-500" value={f.value} onChange={(e) => f.setter(e.target.value)} />
                          </div>
                        ))}
                      </div>
                      <div className="space-y-0.5">
                        <label className="text-[8px] uppercase font-bold text-slate-400">Notes</label>
                        <textarea rows={2} className="w-full text-[10px] p-1 bg-white border border-slate-200 rounded focus:outline-none focus:border-emerald-500" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
                      </div>
                      <div className="flex gap-2">
                        <button type="submit" disabled={isEditing} className="px-2 py-1 bg-emerald-700 hover:bg-emerald-800 text-white text-[10px] font-bold rounded cursor-pointer flex items-center gap-1">
                          {isEditing ? <LoaderIcon className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                          <span>Save Changes</span>
                        </button>
                        <button type="button" onClick={() => setShowEditForm(false)} className="px-2 py-1 border border-slate-200 hover:bg-slate-50 text-slate-600 text-[10px] rounded cursor-pointer flex items-center gap-1">
                          <X className="h-3 w-3" /><span>Cancel</span>
                        </button>
                      </div>
                    </form>
                  ) : showDeleteConfirm ? (
                    <div className="p-3 bg-rose-50 border border-rose-200 rounded space-y-2">
                      <p className="text-[11px] font-bold text-rose-800">Delete {selectedRep.name}?</p>
                      <p className="text-[10px] text-rose-700">This will permanently delete the rep profile <strong>and all price history</strong> associated with them. Invoices will remain but show no linked rep. This cannot be undone.</p>
                      <div className="flex gap-2">
                        <button onClick={handleDeleteRep} disabled={isDeleting} className="px-2 py-1 bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold rounded cursor-pointer flex items-center gap-1">
                          {isDeleting ? <LoaderIcon className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          <span>{isDeleting ? "Deleting price history..." : "Yes, Delete"}</span>
                        </button>
                        <button onClick={() => setShowDeleteConfirm(false)} disabled={isDeleting} className="px-2 py-1 border border-slate-200 hover:bg-slate-50 text-slate-600 text-[10px] rounded cursor-pointer">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[9px] uppercase font-bold tracking-wider text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded">{selectedRep.company}</span>
                        <button onClick={() => setShowEditForm(true)} className="p-1 px-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-[9px] font-bold flex items-center gap-1 cursor-pointer border border-slate-200">
                          <Edit2 className="h-3 w-3" /><span>Edit</span>
                        </button>
                        <button onClick={() => setShowDeleteConfirm(true)} className="p-1 px-2 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded text-[9px] font-bold flex items-center gap-1 cursor-pointer border border-rose-200">
                          <Trash2 className="h-3 w-3" /><span>Delete</span>
                        </button>
                        <button onClick={() => setShowPrintReport(true)} className="p-1 px-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-[9px] font-bold flex items-center gap-1 cursor-pointer border border-slate-200">
                          <PrinterIcon className="h-3 w-3" /><span>Report</span>
                        </button>
                      </div>
                      <h1 className="text-base font-bold text-slate-900 mt-0.5">{selectedRep.name}</h1>
                      <div className="flex flex-wrap items-center gap-2.5 text-[10px] text-slate-600">
                        <span className="flex items-center gap-1"><MailIcon className="h-3 w-3 text-slate-400" /><a href={`mailto:${selectedRep.email}`} className="hover:underline font-mono">{selectedRep.email || "No email"}</a></span>
                        <span className="flex items-center gap-1"><PhoneIcon className="h-3 w-3 text-slate-400" /><a href={`tel:${selectedRep.phone}`} className="hover:underline font-mono">{selectedRep.phone || "No phone"}</a></span>
                      </div>
                      {selectedRep.notes && <p className="text-[10px] text-slate-500 italic bg-slate-50 p-2 rounded border border-slate-150">{selectedRep.notes}</p>}
                    </>
                  )}
                </div>

                {/* STATS */}
                <div className="p-2 bg-emerald-50/40 border border-emerald-100 rounded flex gap-3 shrink-0 text-[10px]">
                  <div className="text-left">
                    <p className="text-[8px] uppercase font-bold text-slate-400 flex items-center gap-0.5"><CalcIcon className="h-2.5 w-2.5" /><span>Spent (7d)</span></p>
                    <p className="text-xs font-extrabold text-emerald-800 mt-0.5">${weeklyExpenseSummary.currentWeekTotal.toFixed(2)}</p>
                  </div>
                  <div className="border-l border-emerald-150 pl-3 text-left">
                    <p className="text-[8px] uppercase font-bold text-slate-400">Total Spent</p>
                    <p className="text-xs font-extrabold text-slate-800 mt-0.5">${weeklyExpenseSummary.lifetimeSpent.toFixed(2)}</p>
                  </div>
                  <div className="border-l border-emerald-150 pl-3 text-left">
                    <p className="text-[8px] uppercase font-bold text-slate-400">Products</p>
                    <p className="text-xs font-extrabold text-slate-800 mt-0.5">{repSuppliedProductIds.length}</p>
                  </div>
                </div>
              </div>

              {/* TABS */}
              <div className="flex gap-1 border-b border-slate-200 pb-0">
                {[
                  { id: "products", label: "Products", icon: <Package className="h-3 w-3" /> },
                  { id: "visits", label: "Visit Notes", icon: <CalendarIcon className="h-3 w-3" /> },
                  { id: "notepad", label: "Notepad", icon: <FileText className="h-3 w-3" /> },
                  { id: "order", label: "Order Draft", icon: <SheetIcon className="h-3 w-3" /> },
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as any)}
                    className={`px-2.5 py-1.5 text-[10px] font-semibold flex items-center gap-1 border-b-2 transition-all cursor-pointer ${activeTab === tab.id ? "border-emerald-600 text-emerald-700" : "border-transparent text-slate-500 hover:text-slate-700"}`}
                  >
                    {tab.icon}<span>{tab.label}</span>
                  </button>
                ))}
              </div>

              {/* TAB: PRODUCTS */}
              {activeTab === "products" && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-2 top-1.5 h-3 w-3 text-slate-400" />
                      <input
                        type="text"
                        placeholder="Search rep's products..."
                        className="w-full text-[10px] pl-7 pr-2 py-1.5 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 bg-slate-50"
                        value={repProductSearch}
                        onChange={(e) => setRepProductSearch(e.target.value)}
                      />
                    </div>
                    <span className="text-[9px] text-slate-400 shrink-0">{filteredSuppliedProducts.length} products</span>
                  </div>

                  {filteredSuppliedProducts.length === 0 ? (
                    <div className="py-8 text-center text-[11px] text-slate-400 border border-dashed rounded">
                      {repSuppliedProductIds.length === 0 ? "No products yet — scan a docket from this rep first." : "No products match your search."}
                    </div>
                  ) : (
                    <>
                    <p className="text-[9px] text-slate-400 pl-1">
                      "Box Price" and "Per Unit" are wholesale, <strong>excluding GST</strong>. "Per Unit (+GST)" includes the 15% GST applied on top. Click the calculator icon to see the docket calculation and any past corrections. Click the pencil icon to fix any field.
                    </p>
                    <div className="overflow-x-auto border border-slate-200 rounded max-h-80 overflow-y-auto">
                      <table className="w-full text-left text-[10px]">
                        <thead className="bg-slate-50 sticky top-0 z-10">
                          <tr className="text-slate-500 font-bold uppercase text-[8px] border-b border-slate-200">
                            <th className="p-1.5 px-2">Product</th>
                            <th className="p-1.5 px-2 text-right">Box Price</th>
                            <th className="p-1.5 px-2 text-center">Units/Box</th>
                            <th className="p-1.5 px-2 text-right">Per Unit</th>
                            <th className="p-1.5 px-2 text-right">Per Unit (+GST)</th>
                            <th className="p-1.5 px-2 text-right">Previous</th>
                            <th className="p-1.5 px-2 text-center">Change</th>
                            <th className="p-1.5 px-2 text-center">Status</th>
                            <th className="p-1.5 px-2 text-center">Edit</th>
                            <th className="p-1.5 px-2 text-center">Remove</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {filteredSuppliedProducts.map(p => {
                            const pd = productPriceData[p.id];
                            const isExpanded = expandedProductId === p.id;
                            const hasAuditTrail = pd?.unitPrice != null;
                            const hasEditHistory = pd?.editHistory && pd.editHistory.length > 0;
                            const canExpand = hasAuditTrail || hasEditHistory;
                            const isFreePromo = (pd?.discPercent ?? 0) >= 100;
                            const isConfirmingDelete = pd?.latestEntryId && confirmDeletePriceId === pd.latestEntryId;
                            return (
                              <React.Fragment key={p.id}>
                                <tr className="hover:bg-slate-50/50">
                                  <td className="p-1.5 px-2">
                                    <p className="font-semibold text-slate-800 line-clamp-1">{p.name}</p>
                                    <p className="text-[8px] text-slate-400 font-mono">{p.id}</p>
                                  </td>
                                  <td className="p-1.5 px-2 text-right font-bold font-mono text-slate-800">
                                    <div className="flex items-center justify-end gap-1">
                                      <span className={isFreePromo ? "text-amber-700" : ""}>${pd?.current?.toFixed(2) || "—"}</span>
                                      {canExpand && (
                                        <button
                                          onClick={() => setExpandedProductId(isExpanded ? null : p.id)}
                                          title="Show docket calculation and edit history"
                                          className="text-slate-400 hover:text-emerald-600 cursor-pointer"
                                        >
                                          <CalcIcon className="h-2.5 w-2.5" />
                                        </button>
                                      )}
                                    </div>
                                  </td>
                                  <td className="p-1.5 px-2 text-center font-bold font-mono text-amber-700">
                                    {pd?.packQuantity ?? "—"}
                                  </td>
                                  <td className="p-1.5 px-2 text-right font-bold font-mono text-emerald-700">
                                    {pd?.current && pd?.packQuantity
                                      ? `$${(pd.current / pd.packQuantity).toFixed(2)}`
                                      : "—"}
                                  </td>
                                  <td className="p-1.5 px-2 text-right font-bold font-mono text-slate-700">
                                    {pd?.current && pd?.packQuantity
                                      ? `$${((pd.current / pd.packQuantity) * 1.15).toFixed(2)}`
                                      : "—"}
                                  </td>
                                  <td className="p-1.5 px-2 text-right font-mono text-slate-400">
                                    {pd?.previous ? `$${pd.previous.toFixed(2)}` : "—"}
                                  </td>
                                  <td className="p-1.5 px-2 text-center">
                                    <div className="flex items-center justify-center gap-1">
                                      {priceChangeIcon(pd?.change ?? null)}
                                      {priceChangeLabel(pd?.change ?? null, pd?.changePct ?? null)}
                                    </div>
                                  </td>
                                  <td className="p-1.5 px-2 text-center">
                                    {p.lowStock && (
                                      <span className="text-[8px] bg-rose-50 text-rose-700 border border-rose-200 px-1 py-0.5 rounded font-bold flex items-center gap-0.5 justify-center">
                                        <AlertIcon className="h-2.5 w-2.5" />LOW
                                      </span>
                                    )}
                                  </td>
                                  <td className="p-1.5 px-2 text-center">
                                    {pd?.latestEntryId && (
                                      <button
                                        onClick={() => handleOpenPriceEdit(p.name, pd)}
                                        title="Edit this price entry"
                                        className="text-slate-400 hover:text-emerald-600 cursor-pointer"
                                      >
                                        <Edit2 className="h-3 w-3" />
                                      </button>
                                    )}
                                  </td>
                                  <td className="p-1.5 px-2 text-center">
                                    {pd?.latestEntryId && (
                                      <button
                                        onClick={() => setConfirmDeletePriceId(isConfirmingDelete ? null : pd.latestEntryId)}
                                        title="Remove this price entry"
                                        className="text-slate-400 hover:text-rose-600 cursor-pointer"
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </button>
                                    )}
                                  </td>
                                </tr>
                                {isConfirmingDelete && (
                                  <tr className="bg-rose-50">
                                    <td colSpan={10} className="p-1.5 px-2 text-[9px] text-rose-800">
                                      <span className="font-bold">Remove this price entry for "{p.name}"?</span> This only deletes this one entry — the rep profile and other products are not affected.
                                      <button
                                        onClick={() => handleDeletePriceEntry(pd.latestEntryId)}
                                        disabled={isDeletingPrice}
                                        className="ml-2 px-1.5 py-0.5 bg-rose-600 hover:bg-rose-700 text-white text-[9px] font-bold rounded cursor-pointer disabled:opacity-50"
                                      >
                                        {isDeletingPrice ? "Removing..." : "Yes, remove"}
                                      </button>
                                      <button
                                        onClick={() => setConfirmDeletePriceId(null)}
                                        disabled={isDeletingPrice}
                                        className="ml-1.5 px-1.5 py-0.5 border border-slate-300 hover:bg-slate-100 text-slate-600 text-[9px] rounded cursor-pointer"
                                      >
                                        Cancel
                                      </button>
                                    </td>
                                  </tr>
                                )}
                                {isExpanded && canExpand && (
                                  <tr className={isFreePromo ? "bg-amber-50" : "bg-emerald-50/40"}>
                                    <td colSpan={10} className={`p-1.5 px-2 text-[9px] ${isFreePromo ? "text-amber-800" : "text-emerald-800"} space-y-1.5`}>
                                      {hasAuditTrail && (
                                        <div>
                                          <span className="font-bold">From docket:</span>{" "}
                                          ${pd!.unitPrice!.toFixed(2)} unit price × (1 − {pd!.discPercent ?? 0}% disc) = ${pd!.current?.toFixed(2)} box price (excl. GST)
                                          {isFreePromo && (
                                            <span className="ml-1.5 font-bold">— 100% discount, likely free/promo. Do not use for retail pricing.</span>
                                          )}
                                          {pd?.effectiveDate && (
                                            <span className={`ml-2 ${isFreePromo ? "text-amber-600" : "text-emerald-600"}`}>
                                              · Scanned {new Date(pd.effectiveDate?.seconds ? pd.effectiveDate.seconds * 1000 : pd.effectiveDate).toLocaleDateString()}
                                            </span>
                                          )}
                                        </div>
                                      )}
                                      {hasEditHistory && (
                                        <div className={hasAuditTrail ? "pt-1.5 border-t border-emerald-100" : ""}>
                                          <span className="font-bold flex items-center gap-1">
                                            <HistoryIcon className="h-2.5 w-2.5" />
                                            Edit history ({pd.editHistory.length} correction{pd.editHistory.length > 1 ? "s" : ""}):
                                          </span>
                                          <ul className="mt-1 space-y-0.5">
                                            {[...pd.editHistory].reverse().map((h, i) => (
                                              <li key={i} className="pl-3">
                                                {new Date(h.editedAt).toLocaleDateString()} {new Date(h.editedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} —{" "}
                                                Box Price was <strong>${h.previousBoxPrice.toFixed(2)}</strong>
                                                {h.previousPackQuantity != null && <>, Units/Box was <strong>{h.previousPackQuantity}</strong></>}
                                                {h.previousUnitPrice != null && <>, Unit Price was <strong>${h.previousUnitPrice.toFixed(2)}</strong></>}
                                                {h.previousDiscPercent != null && <>, Disc% was <strong>{h.previousDiscPercent}%</strong></>}
                                              </li>
                                            ))}
                                          </ul>
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    </>
                  )}
                </div>
              )}

              {/* TAB: VISIT NOTES */}
              {activeTab === "visits" && (
                <div className="space-y-2.5">
                  <form onSubmit={handleAddVisitLog} className="space-y-2 p-2.5 bg-slate-50 rounded border border-slate-200">
                    <p className="text-[9px] text-slate-400">Log credit notes, delivery delays, price agreements.</p>
                    <textarea
                      rows={2} required
                      className="w-full text-[10px] p-1.5 bg-white border border-slate-200 rounded focus:outline-none focus:border-emerald-500"
                      placeholder="e.g. Ahmed promised $50 credit next invoice..."
                      value={visitText}
                      onChange={(e) => setVisitText(e.target.value)}
                    />
                    <div className="flex justify-between items-center">
                      {visitSuccess && <span className="text-[9px] text-emerald-700 font-semibold flex items-center gap-0.5"><CheckIcon className="h-3 w-3" /> Saved</span>}
                      <button type="submit" className="ml-auto px-2 py-0.5 bg-slate-900 hover:bg-slate-800 text-white text-[9px] font-semibold rounded cursor-pointer">Log Entry</button>
                    </div>
                  </form>

                  <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                    {repVisits.length === 0 ? (
                      <p className="text-[10px] text-slate-400 py-4 text-center italic">No visit notes yet.</p>
                    ) : (
                      repVisits.map(v => (
                        <div key={v.id} className="p-2 bg-white border border-slate-150 rounded text-[10px] space-y-1">
                          <p className="text-slate-700 leading-snug">{v.notes}</p>
                          <p className="text-[8px] text-slate-400 font-mono">{new Date(v.createdAt?.seconds ? v.createdAt.seconds * 1000 : v.createdAt).toLocaleDateString()}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* TAB: NOTEPAD */}
              {activeTab === "notepad" && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] text-slate-500">One persistent notepad per rep — edit anytime, print to share.</p>
                    <div className="flex gap-1.5">
                      <button onClick={handlePrintNotepad} className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-[9px] font-bold rounded cursor-pointer flex items-center gap-1 border border-slate-200">
                        <PrinterIcon className="h-3 w-3" /><span>Print</span>
                      </button>
                      <button onClick={handleSaveNotepad} disabled={notepadSaving} className="px-2 py-1 bg-emerald-700 hover:bg-emerald-800 text-white text-[9px] font-bold rounded cursor-pointer flex items-center gap-1 disabled:opacity-50">
                        {notepadSaving ? <LoaderIcon className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                        <span>{notepadSaved ? "Saved!" : "Save"}</span>
                      </button>
                    </div>
                  </div>
                  {!notepadLoaded ? (
                    <div className="py-8 text-center text-[10px] text-slate-400 flex items-center justify-center gap-2">
                      <LoaderIcon className="h-4 w-4 animate-spin" /> Loading notepad...
                    </div>
                  ) : (
                    <textarea
                      rows={12}
                      className="w-full text-[11px] p-3 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 bg-slate-50 font-mono leading-relaxed resize-none"
                      placeholder={`Notes for ${selectedRep.name}...\n\nExamples:\n- Need more Musashi Mango 500ml\n- Ask about bulk discount on Oxyshred\n- Check on delayed Nerds delivery\n- Price went up on Kobi Peanuts — negotiate`}
                      value={notepadText}
                      onChange={(e) => setNotepadText(e.target.value)}
                    />
                  )}
                  <p className="text-[9px] text-slate-400">This notepad is saved permanently to Firebase under this rep. Edit and save as needed.</p>
                </div>
              )}

              {/* TAB: ORDER DRAFT */}
              {activeTab === "order" && (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <p className="text-[9px] text-slate-500">Set quantities for products to order. Low stock items flagged.</p>
                    {lowStockSuppliedProducts.length > 0 && (
                      <button
                        onClick={() => {
                          const qtys: { [pId: string]: number } = {};
                          lowStockSuppliedProducts.forEach(p => { qtys[p.id] = 5; });
                          setOrderQtys(prev => ({ ...prev, ...qtys }));
                        }}
                        className="text-[8px] font-bold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 p-1 rounded cursor-pointer border border-emerald-200"
                      >
                        Load {lowStockSuppliedProducts.length} Low Stock Items
                      </button>
                    )}
                  </div>

                  {suppliedProducts.length === 0 ? (
                    <p className="text-[10px] text-slate-400 py-6 text-center italic border border-dashed rounded">No products mapped. Scan a docket first.</p>
                  ) : (
                    <>
                      <div className="max-h-48 overflow-y-auto space-y-1 bg-slate-50/50 p-1.5 rounded border border-slate-200">
                        {suppliedProducts.map(p => {
                          const pd = productPriceData[p.id];
                          return (
                            <div key={p.id} className="flex items-center justify-between p-1 hover:bg-white rounded text-[10px] border border-transparent hover:border-slate-150">
                              <div className="space-y-0.5 text-left max-w-[200px]">
                                <p className="font-semibold text-slate-800 line-clamp-1">{p.name}</p>
                                <div className="flex items-center gap-1 text-[8px]">
                                  <span className="text-slate-400 font-mono">${pd?.current?.toFixed(2) || "0.00"}</span>
                                  {p.lowStock && <span className="font-bold text-amber-700 bg-amber-50 px-0.5 rounded">LOW</span>}
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <span className="text-[8px] text-slate-400 font-bold">Qty:</span>
                                <input
                                  type="number" min="0"
                                  className="w-10 p-0.5 border border-slate-200 text-[10px] rounded text-center focus:outline-none focus:ring-1 focus:ring-emerald-500 bg-white font-bold"
                                  value={orderQtys[p.id] || 0}
                                  onChange={(e) => setOrderQtys(prev => ({ ...prev, [p.id]: parseInt(e.target.value) || 0 }))}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {draftOrderSummary.items.length > 0 && (
                        <div className="p-2 bg-slate-50 border border-slate-200 rounded space-y-2">
                          <div className="flex justify-between items-baseline text-[10px]">
                            <span className="font-bold text-slate-500">Estimated Total:</span>
                            <span className="text-xs font-extrabold text-emerald-800">${draftOrderSummary.totalCost.toFixed(2)}</span>
                          </div>
                          <div className="grid grid-cols-2 gap-1.5">
                            <button
                              onClick={handleCopyOrderText}
                              className="py-1 bg-emerald-700 hover:bg-emerald-800 text-white text-[10px] font-semibold rounded flex items-center justify-center gap-1 cursor-pointer"
                            >
                              {copiedOrder ? <><CheckIcon className="h-3 w-3" /><span>Copied!</span></> : <><CopyIcon className="h-3 w-3" /><span>Copy Order</span></>}
                            </button>
                            <button
                              onClick={handlePrintPurchaseOrder}
                              className="py-1 bg-slate-900 hover:bg-slate-800 text-white text-[10px] font-semibold rounded flex items-center justify-center gap-1 cursor-pointer"
                            >
                              <PrinterIcon className="h-3 w-3" /><span>Print Order</span>
                            </button>
                          </div>
                          <p className="text-[8px] text-slate-400 text-center">Copy/Print only includes product names &amp; quantities — no prices.</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

            </div>
          ) : (
            <div className="bg-white rounded-md shadow-sm border border-slate-200 p-12 text-center text-slate-400 flex flex-col items-center justify-center h-[600px]">
              <UsersIcon className="h-8 w-8 text-slate-300 mb-2" />
              <h3 className="text-xs font-bold text-slate-700">Select a Rep</h3>
              <p className="text-[10px] text-slate-400 mt-1 max-w-xs leading-normal">Click a supplier rep on the left to view their products, prices, visit notes and order drafts.</p>
            </div>
          )}
        </div>
      </div>

      {/* PRICE EDIT MODAL */}
      {editingPrice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="bg-white rounded-lg shadow-2xl border border-slate-200 w-full max-w-md p-5 relative">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2.5 mb-3">
              <div>
                <h2 className="text-xs font-extrabold text-slate-800">Edit Price Entry</h2>
                <p className="text-[10px] text-slate-500 mt-0.5 line-clamp-1">{editingPrice.productName}</p>
              </div>
              <button
                onClick={() => setEditingPrice(null)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {priceEditError && (
              <div className="p-2 bg-rose-50 text-rose-800 border border-rose-200 rounded text-[10px] flex items-center gap-1.5 mb-3">
                <AlertCircleIcon className="h-3.5 w-3.5 shrink-0 text-rose-600" />
                <span>{priceEditError}</span>
              </div>
            )}

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-0.5">
                  <label className="text-[9px] uppercase font-bold text-slate-400">Unit Price ($) *</label>
                  <input
                    type="number" step="0.01" required
                    className="w-full text-[11px] p-1.5 bg-white border border-slate-200 rounded focus:outline-none focus:border-emerald-500 font-mono font-bold"
                    placeholder="Pre-discount box price"
                    value={editingPrice.unitPrice}
                    onChange={(e) => setEditingPrice({ ...editingPrice, unitPrice: e.target.value })}
                  />
                </div>
                <div className="space-y-0.5">
                  <label className="text-[9px] uppercase font-bold text-slate-400">Disc % *</label>
                  <input
                    type="number" min="0" max="100" step="0.01" required
                    className="w-full text-[11px] p-1.5 bg-white border border-slate-200 rounded focus:outline-none focus:border-emerald-500 font-mono font-bold"
                    placeholder="0"
                    value={editingPrice.discPercent}
                    onChange={(e) => setEditingPrice({ ...editingPrice, discPercent: e.target.value })}
                  />
                </div>
                <div className="space-y-0.5 col-span-2">
                  <label className="text-[9px] uppercase font-bold text-slate-400">Units/Box *</label>
                  <input
                    type="number" min="1" required
                    className="w-full text-[11px] p-1.5 bg-white border border-slate-200 rounded focus:outline-none focus:border-emerald-500 font-mono font-bold"
                    value={editingPrice.packQuantity}
                    onChange={(e) => setEditingPrice({ ...editingPrice, packQuantity: e.target.value })}
                  />
                </div>
              </div>

              <p className="text-[8px] text-slate-400">
                Box Price is calculated automatically as Unit Price × (1 − Disc%) — it's no longer a separate field to avoid it drifting out of sync. The previous values are kept in this product's edit history.
              </p>

              {editPreview && (
                <div className="p-2 bg-emerald-50/60 border border-emerald-200 rounded text-[10px] text-emerald-800 space-y-0.5">
                  <div><span className="font-bold">Box Price (will be saved):</span> ${editPreview.boxPrice.toFixed(2)}</div>
                  <div className="text-emerald-700">Per Unit ${editPreview.perUnit.toFixed(2)} · Per Unit (+GST) ${editPreview.perUnitGst.toFixed(2)}</div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-4 mt-2 border-t border-slate-200">
              <button
                onClick={() => setEditingPrice(null)}
                disabled={isSavingPriceEdit}
                className="px-3 py-1.5 border border-slate-200 hover:bg-slate-50 text-slate-600 text-[11px] font-semibold rounded cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSavePriceEdit}
                disabled={isSavingPriceEdit}
                className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-[11px] font-bold rounded cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
              >
                {isSavingPriceEdit ? <LoaderIcon className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                <span>{isSavingPriceEdit ? "Saving..." : "Save Changes"}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PRINT REPORT MODAL */}
      {showPrintReport && selectedRep && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 overflow-y-auto">
          <div className="bg-white rounded-lg shadow-2xl border border-slate-200 w-full max-w-4xl p-6 relative max-h-[90vh] overflow-y-auto flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-4">
              <div className="flex items-center gap-2">
                <PrinterIcon className="h-4 w-4 text-emerald-700" />
                <h2 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider">Supplier Briefing Report</h2>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => window.print()} className="p-1.5 px-3 bg-emerald-700 hover:bg-emerald-800 text-white rounded text-[11px] font-bold flex items-center gap-1.5 cursor-pointer">
                  <PrinterIcon className="h-3.5 w-3.5" /><span>Print</span>
                </button>
                <button onClick={() => setShowPrintReport(false)} className="p-1.5 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-[11px] font-bold cursor-pointer border border-slate-200">Close</button>
              </div>
            </div>

            <div id="printable-report-area" className="flex-1 bg-white text-slate-900 p-6 rounded border border-slate-200 font-sans">
              <style>{`@media print { body * { visibility: hidden !important; } #printable-report-area, #printable-report-area * { visibility: visible !important; } #printable-report-area { position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important; padding: 40px !important; } }`}</style>

              <div className="border-b-4 border-emerald-800 pb-3 mb-6 flex items-center justify-between">
                <div>
                  <h1 className="text-lg font-black text-emerald-800 tracking-wider">CHAPEL DOWNS SUPERMARKET</h1>
                  <p className="text-[9px] text-slate-500 uppercase tracking-widest font-semibold">Procurement & Supplier Management</p>
                </div>
                <div className="text-right">
                  <span className="text-[9px] font-mono font-bold bg-slate-100 text-slate-700 px-2 py-0.5 rounded">Supplier Briefing</span>
                  <p className="text-[8px] font-mono text-slate-400 mt-1">{new Date().toLocaleString()}</p>
                </div>
              </div>

              <div className="mb-6 bg-slate-50 border-l-4 border-emerald-600 p-4 rounded">
                <h2 className="text-[11px] text-emerald-800 uppercase font-extrabold tracking-wider">Representative Summary</h2>
                <h1 className="text-lg font-black text-slate-950 mt-0.5">{selectedRep.name}</h1>
                <p className="text-[10px] text-slate-600 mt-1">{selectedRep.company} | {selectedRep.phone || "No phone"} | {selectedRep.email || "No email"}</p>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="border border-slate-200 rounded p-4">
                  <h3 className="text-[10px] uppercase font-bold text-slate-500 border-b pb-1 mb-2">Spend Summary</h3>
                  <div className="space-y-1.5 text-[11px]">
                    <div className="flex justify-between"><span className="text-slate-500">Last 7 Days:</span><span className="font-bold text-emerald-700">${weeklyExpenseSummary.currentWeekTotal.toFixed(2)}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Total Lifetime:</span><span className="font-bold">${weeklyExpenseSummary.lifetimeSpent.toFixed(2)}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Products Supplied:</span><span className="font-bold">{repSuppliedProductIds.length}</span></div>
                  </div>
                </div>
                <div className="border border-slate-200 rounded p-4">
                  <h3 className="text-[10px] uppercase font-bold text-slate-500 border-b pb-1 mb-2">Notepad</h3>
                  <p className="text-[10px] text-slate-700 leading-relaxed whitespace-pre-wrap">{notepadText || "No notes."}</p>
                </div>
              </div>

              <div className="mb-6">
                <h3 className="text-[10px] uppercase font-bold text-slate-500 border-b pb-1 mb-2">Recent Visit Notes</h3>
                {repVisits.length === 0 ? (
                  <p className="text-[10px] text-slate-400 italic">No visit notes.</p>
                ) : (
                  <div className="space-y-2">
                    {repVisits.slice(0, 5).map((v, i) => (
                      <div key={v.id} className="text-[10px] border-l-2 border-slate-200 pl-3">
                        <p className="text-slate-400 text-[8px] mb-0.5">#{repVisits.length - i} — {new Date(v.createdAt?.seconds ? v.createdAt.seconds * 1000 : v.createdAt).toLocaleDateString()}</p>
                        <p className="text-slate-700">{v.notes}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-[10px] uppercase font-bold text-slate-500 border-b pb-1 mb-2">Product Price Changes</h3>
                <table className="w-full text-[10px] border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-[8px] uppercase text-slate-500 font-bold">
                      <th className="p-2 text-left">Product</th>
                      <th className="p-2 text-right">Previous</th>
                      <th className="p-2 text-right">Current</th>
                      <th className="p-2 text-right">Change</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredSuppliedProducts.slice(0, 20).map(p => {
                      const pd = productPriceData[p.id];
                      return (
                        <tr key={p.id}>
                          <td className="p-2 font-semibold text-slate-800">{p.name}</td>
                          <td className="p-2 text-right font-mono text-slate-400">{pd?.previous ? `$${pd.previous.toFixed(2)}` : "—"}</td>
                          <td className="p-2 text-right font-mono font-bold">${pd?.current?.toFixed(2) || "—"}</td>
                          <td className="p-2 text-right">
                            {pd?.change !== null && pd?.change !== undefined && pd.change !== 0 ? (
                              <span className={`font-bold text-[8px] ${pd.change > 0 ? "text-rose-600" : "text-emerald-600"}`}>
                                {pd.change > 0 ? "+" : ""}${pd.change.toFixed(2)}
                              </span>
                            ) : <span className="text-slate-400 text-[8px]">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-8 border-t border-dashed border-slate-300 pt-6 flex justify-between items-end">
                <p className="text-[9px] text-slate-400 max-w-md">Chapel Downs Supermarket — Confidential procurement document.</p>
                <div className="text-right w-44">
                  <div className="border-b border-slate-300 h-8"></div>
                  <p className="text-[8px] uppercase text-slate-400 mt-1 font-bold">Manager Signature</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}