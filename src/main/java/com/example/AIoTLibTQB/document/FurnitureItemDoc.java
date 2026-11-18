package com.example.AIoTLibTQB.document;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import lombok.*;
import lombok.experimental.FieldDefaults;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE)
public class FurnitureItemDoc {

    @NotBlank
    @Size(max = 80)
    String id;

    @NotBlank
    @Size(max = 60)
    String typeId;

    @Size(max = 120)
    String label;

    @NotNull
    @DecimalMin("0.0")
    @DecimalMax("1.0")
    Double x;

    @NotNull
    @DecimalMin("0.0")
    @DecimalMax("1.0")
    Double y;

    @NotNull
    @DecimalMin("0.1")
    @DecimalMax("25.0")
    Double widthM;

    @NotNull
    @DecimalMin("0.1")
    @DecimalMax("25.0")
    Double depthM;

    @Builder.Default
    Double rotationDeg = 0.0;

    @Builder.Default
    Boolean locked = false;
}
