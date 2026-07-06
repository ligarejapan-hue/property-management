import { describe, it, expect } from "vitest";
import { buildPropertyDataFromPin, buildPropertyPhotoDataFromPinPhoto } from "../field-survey-convert";

describe("buildPropertyDataFromPin", () => {
  const pin = { lat: 35.1234567, lng: 139.7654321 };

  it("introductionRoute=field_survey・GPS はピン継承・種別/住所/地番は入力を反映", () => {
    const data = buildPropertyDataFromPin(
      { propertyType: "land", address: "東京都千代田区丸の内1-1-1", lotNumber: "1番1" },
      pin,
      "user-1",
    );
    expect(data.introductionRoute).toBe("field_survey");
    expect(data.gpsLat).toBe(35.1234567);
    expect(data.gpsLng).toBe(139.7654321);
    expect(data.propertyType).toBe("land");
    expect(data.address).toBe("東京都千代田区丸の内1-1-1");
    expect(data.lotNumber).toBe("1番1");
    expect(data.createdBy).toBe("user-1");
  });

  it("任意項目未指定は null・新規物件の既定 status を付与", () => {
    const data = buildPropertyDataFromPin({ propertyType: "house", address: "x" }, pin, "u");
    expect(data.lotNumber).toBeNull();
    expect(data.buildingNumber).toBeNull();
    expect(data.realEstateNumber).toBeNull();
    expect(data.registryStatus).toBe("unconfirmed");
    expect(data.dmStatus).toBe("hold");
    expect(data.caseStatus).toBe("new_case");
  });
});

describe("buildPropertyPhotoDataFromPinPhoto", () => {
  const pinPhoto = {
    fileName: "site.jpg",
    fileSize: 12345,
    mimeType: "image/jpeg",
    uploadedByUserId: "staff-9",
    sortOrder: 2,
  };

  it("takenBy=撮影者(uploadedByUserId)・sortOrder保持・GPS/caption/thumbnailは付けない", () => {
    const data = buildPropertyPhotoDataFromPinPhoto(pinPhoto, "prop-1", "/uploads/properties/prop-1/photos/x.jpg");
    expect(data).toEqual({
      propertyId: "prop-1",
      fileUrl: "/uploads/properties/prop-1/photos/x.jpg",
      fileName: "site.jpg",
      fileSize: 12345,
      mimeType: "image/jpeg",
      takenBy: "staff-9",
      sortOrder: 2,
    });
    expect(data).not.toHaveProperty("gpsLat");
    expect(data).not.toHaveProperty("caption");
    expect(data).not.toHaveProperty("thumbnailUrl");
  });
});
