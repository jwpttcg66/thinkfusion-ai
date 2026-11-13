package com.acme.nested;

public class Nested {
    private int value;

    static class StaticNested {
        int read() {
            return 1;
        }
    }

    class Inner {
        int read() {
            return value;
        }
    }

    void local() {
        class Local {
            int read() {
                return value;
            }
        }
        Runnable anonymous = new Runnable() {
            @Override
            public void run() {
                value += 1;
            }
        };
        anonymous.run();
        new Local().read();
    }
}
