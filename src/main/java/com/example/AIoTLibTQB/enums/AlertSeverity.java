package com.example.AIoTLibTQB.enums;

public enum AlertSeverity {
    LOW(1),
    MEDIUM(2),
    HIGH(3),
    CRITICAL(4);

    private final int rank;

    AlertSeverity(int rank) {
        this.rank = rank;
    }

    public int getRank() {
        return rank;
    }

    public static int rankOf(AlertSeverity severity) {
        return severity != null ? severity.getRank() : MEDIUM.getRank();
    }
}

