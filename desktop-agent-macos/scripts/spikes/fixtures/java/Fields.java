package com.acme.fields;

import java.util.ArrayList;
import java.util.List;

public class Fields<T> {
    public static final String NAME = "fields";
    private int[] numbers = {1, 2, 3};
    private List<T> values = new ArrayList<>();
    private volatile boolean ready;
    private transient String cache;

    static {
        NAME.length();
    }

    {
        ready = true;
    }
}
