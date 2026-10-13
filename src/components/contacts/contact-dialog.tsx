"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { createContactAction, updateContactAction, archiveContactAction, restoreContactAction, getContactsAction, getContactAction, getContactBalanceAction } from "@/server/actions/contact";

const addressSchema = z.object({
  type: z.enum(["POSTAL", "PHYSICAL"]),
  line1: z.string().min(1, "Address line 1 is required").max(200),
  line2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().length(2).optional(),
  isDefault: z.boolean().default(false),
});

const contactSchema = z.object({
  type: z.enum(["INDIVIDUAL", "BUSINESS"]).default("INDIVIDUAL"),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  companyName: z.string().max(200).optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().max(50).optional(),
  mobile: z.string().max(50).optional(),
  taxPin: z.string().max(50).optional(),
  notes: z.string().max(2000).optional(),
  addresses: z.array(addressSchema).max(2).optional(),
}).refine(
  (data) => {
    if (data.type === "INDIVIDUAL") {
      return data.firstName?.trim() || data.lastName?.trim();
    }
    return data.companyName?.trim();
  },
  {
    message: "Individual contacts require a name; business contacts require a company name",
    path: ["type"],
  }
);

type ContactFormData = z.infer<typeof contactSchema>;

const DEFAULT_VALUES: ContactFormData = {
  type: "INDIVIDUAL",
  firstName: "",
  lastName: "",
  companyName: "",
  email: "",
  phone: "",
  mobile: "",
  taxPin: "",
  notes: "",
  addresses: [],
};

interface ContactDialogProps {
  tenantId: string;
  contactId?: string;
  onSuccess: () => void;
}

export function ContactDialog({ tenantId, contactId, onSuccess }: ContactDialogProps) {
  const router = useRouter();
  const isEditing = !!contactId;
  const [isLoading, setIsLoading] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [addresses, setAddresses] = React.useState<z.infer<typeof addressSchema>[]>([]);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    control,
    formState: { errors },
  } = useForm<ContactFormData>({
    resolver: zodResolver(contactSchema),
    defaultValues: DEFAULT_VALUES,
  });

  const type = watch("type");

  React.useEffect(() => {
    if (contactId) {
      async function loadContact() {
        const result = await getContactAction(contactId, tenantId);
        if (result.success && result.data.contact) {
          const c = result.data.contact;
          setValue("type", c.type);
          setValue("firstName", c.firstName || "");
          setValue("lastName", c.lastName || "");
          setValue("companyName", c.companyName || "");
          setValue("email", c.email || "");
          setValue("phone", c.phone || "");
          setValue("mobile", c.mobile || "");
          setValue("taxPin", c.taxPin || "");
          setValue("notes", c.notes || "");
          setAddresses(c.addresses.map((a) => ({
            type: a.type,
            line1: a.line1,
            line2: a.line2 || "",
            city: a.city || "",
            state: a.state || "",
            postalCode: a.postalCode || "",
            country: a.country || "",
            isDefault: a.isDefault,
          })));
        }
      }
      loadContact();
    }
  }, [contactId, tenantId, setValue]);

  const onSubmit = async (data: ContactFormData) => {
    setIsLoading(true);
    setServerError(null);

    try {
      const payload = {
        ...data,
        addresses: addresses.filter((a) => a.line1.trim()),
      };

      let result;
      if (isEditing) {
        result = await updateContactAction({
          contactId,
          tenantId,
          ...payload,
        });
      } else {
        result = await createContactAction({
          tenantId,
          ...payload,
        });
      }

      if (result.success) {
        onSuccess();
        router.refresh();
      } else {
        setServerError(result.error || "Failed to save contact");
      }
    } catch (err) {
      setServerError("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  const addAddress = (type: "POSTAL" | "PHYSICAL") => {
    setAddresses((prev) => [...prev, { type, line1: "", line2: "", city: "", state: "", postalCode: "", country: "KE", isDefault: prev.length === 0 }]);
  };

  const removeAddress = (index: number) => {
    setAddresses((prev) => prev.filter((_, i) => i !== index));
  };

  const updateAddress = (index: number, field: keyof z.infer<typeof addressSchema>, value: string | boolean) => {
    setAddresses((prev) => prev.map((a, i) => (i === index ? { ...a, [field]: value } : a)));
  };

  if (!isEditing && contactId) return null;

  return (
    <Dialog open={true} onOpenChange={() => onSuccess()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Contact" : "New Contact"}</DialogTitle>
          <DialogDescription>
            {isEditing ? "Update the contact details below." : "Add a new contact to your CRM."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 p-4">
          {serverError && (
            <div className="text-sm text-destructive" role="alert">{serverError}</div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="type">Type <span className="text-destructive">*</span></Label>
              <Select id="type" {...register("type")}>
                <option value="INDIVIDUAL">Individual</option>
                <option value="BUSINESS">Business</option>
              </Select>
            </div>
          </div>

          {type === "INDIVIDUAL" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="firstName">First Name <span className="text-destructive">*</span></Label>
                <Input id="firstName" {...register("firstName")} maxLength={100} />
                {errors.firstName && <p className="text-xs text-destructive">{errors.firstName.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lastName">Last Name <span className="text-destructive">*</span></Label>
                <Input id="lastName" {...register("lastName")} maxLength={100} />
                {errors.lastName && <p className="text-xs text-destructive">{errors.lastName.message}</p>}
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="companyName">Company Name <span className="text-destructive">*</span></Label>
              <Input id="companyName" {...register("companyName")} maxLength={200} />
              {errors.companyName && <p className="text-xs text-destructive">{errors.companyName.message}</p>}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" {...register("email")} maxLength={254} />
              {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" {...register("phone")} maxLength={50} />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="mobile">Mobile</Label>
              <Input id="mobile" {...register("mobile")} maxLength={50} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="taxPin">Tax PIN</Label>
              <Input id="taxPin" {...register("taxPin")} maxLength={50} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" {...register("notes")} maxLength={2000} rows={3} />
          </div>

          <div className="space-y-4 border-t border-border pt-4">
            <div className="flex items-center justify-between">
              <Label>Addresses</Label>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => addAddress("POSTAL")}>
                  Add Postal
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => addAddress("PHYSICAL")}>
                  Add Physical
                </Button>
              </div>
            </div>
            {addresses.length === 0 ? (
              <p className="text-sm text-muted-foreground">No addresses added yet.</p>
            ) : (
              addresses.map((addr, index) => (
                <div key={index} className="space-y-3 p-4 border border-border rounded-lg bg-muted/30">
                  <div className="flex items-center justify-between">
                    <Label className="capitalize">{addr.type.toLowerCase()} address</Label>
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeAddress(index)}>
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </Button>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={`addr-line1-${index}`}>Line 1 <span className="text-destructive">*</span></Label>
                      <Input
                        id={`addr-line1-${index}`}
                        value={addr.line1}
                        onChange={(e) => updateAddress(index, "line1", e.target.value)}
                        maxLength={200}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`addr-line2-${index}`}>Line 2</Label>
                      <Input
                        id={`addr-line2-${index}`}
                        value={addr.line2}
                        onChange={(e) => updateAddress(index, "line2", e.target.value)}
                        maxLength={200}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`addr-city-${index}`}>City</Label>
                      <Input
                        id={`addr-city-${index}`}
                        value={addr.city}
                        onChange={(e) => updateAddress(index, "city", e.target.value)}
                        maxLength={100}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`addr-state-${index}`}>State/Province</Label>
                      <Input
                        id={`addr-state-${index}`}
                        value={addr.state}
                        onChange={(e) => updateAddress(index, "state", e.target.value)}
                        maxLength={100}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`addr-postal-${index}`}>Postal Code</Label>
                      <Input
                        id={`addr-postal-${index}`}
                        value={addr.postalCode}
                        onChange={(e) => updateAddress(index, "postalCode", e.target.value)}
                        maxLength={20}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`addr-country-${index}`}>Country (ISO-2)</Label>
                      <Input
                        id={`addr-country-${index}`}
                        value={addr.country}
                        onChange={(e) => updateAddress(index, "country", e.target.value.toUpperCase())}
                        maxLength={2}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id={`addr-default-${index}`}
                        checked={addr.isDefault}
                        onChange={(e) => updateAddress(index, "isDefault", e.target.checked)}
                        className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                      />
                      <Label htmlFor={`addr-default-${index}`} className="mb-0">Default</Label>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onSuccess()}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? "Saving..." : isEditing ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}