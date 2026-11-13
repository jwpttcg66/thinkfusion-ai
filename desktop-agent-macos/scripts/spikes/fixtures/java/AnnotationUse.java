package com.acme.annotations;

import java.lang.annotation.ElementType;
import java.lang.annotation.Repeatable;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target({ElementType.TYPE, ElementType.METHOD})
@Retention(RetentionPolicy.RUNTIME)
@Repeatable(Tags.class)
@interface Tag {
    String value() default "";
}

@interface Tags {
    Tag[] value();
}

@Tag("a")
@Tag("b")
public class AnnotationUse {
    @Deprecated(since = "21")
    public void old() {
    }
}
