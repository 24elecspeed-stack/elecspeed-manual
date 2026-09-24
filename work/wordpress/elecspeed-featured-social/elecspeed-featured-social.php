<?php
/**
 * Plugin Name: Elecspeed Featured Social Image
 * Description: Use each electric_case featured image for Yoast Open Graph and X metadata, including REST responses.
 * Version: 1.0.0
 * Requires PHP: 7.4
 */

defined( 'ABSPATH' ) || exit;

// Resolve from Yoast's model, not the global query: REST can render many posts.
function elecspeed_fsi_image( $presentation ) {
    if ( ! is_object( $presentation ) || ! isset( $presentation->model ) ) {
        return null;
    }
    $model = $presentation->model;
    if ( $model->object_type !== 'post' || $model->object_sub_type !== 'electric_case' ) {
        return null;
    }
    $id = get_post_thumbnail_id( (int) $model->object_id );
    if ( ! $id || ! wp_attachment_is_image( $id ) ) {
        return null;
    }
    $src = wp_get_attachment_image_src( $id, 'full' );
    if ( ! $src || empty( $src[0] ) ) {
        return null;
    }
    return array(
        'url'    => $src[0],
        'width'  => (int) $src[1],
        'height' => (int) $src[2],
        'type'   => get_post_mime_type( $id ),
    );
}

function elecspeed_fsi_presentation( $presentation ) {
    $image = elecspeed_fsi_image( $presentation );
    if ( $image ) {
        $presentation->open_graph_images = array( $image );
        $presentation->twitter_image = $image['url'];
    }
    return $presentation;
}
add_filter( 'wpseo_frontend_presentation', 'elecspeed_fsi_presentation', 999, 1 );

// Keep late tag-level overrides consistent with the complete image object.
function elecspeed_fsi_url( $value, $presentation = null ) {
    $image = elecspeed_fsi_image( $presentation );
    return $image ? $image['url'] : $value;
}
function elecspeed_fsi_width( $value, $presentation = null ) {
    $image = elecspeed_fsi_image( $presentation );
    return $image ? $image['width'] : $value;
}
function elecspeed_fsi_height( $value, $presentation = null ) {
    $image = elecspeed_fsi_image( $presentation );
    return $image ? $image['height'] : $value;
}
function elecspeed_fsi_type( $value, $presentation = null ) {
    $image = elecspeed_fsi_image( $presentation );
    return $image ? $image['type'] : $value;
}
add_filter( 'wpseo_opengraph_image', 'elecspeed_fsi_url', 999, 2 );
add_filter( 'wpseo_opengraph_image_width', 'elecspeed_fsi_width', 999, 2 );
add_filter( 'wpseo_opengraph_image_height', 'elecspeed_fsi_height', 999, 2 );
add_filter( 'wpseo_opengraph_image_type', 'elecspeed_fsi_type', 999, 2 );
add_filter( 'wpseo_twitter_image', 'elecspeed_fsi_url', 999, 2 );
