package com.acme.enums;

public enum Enums implements Runnable {
    A(1) {
        @Override
        public void run() {
        }
    },
    B(2);

    private final int code;

    Enums(int code) {
        this.code = code;
    }

    public int code() {
        return code;
    }

    @Override
    public void run() {
    }
}
